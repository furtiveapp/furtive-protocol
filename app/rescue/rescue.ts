// Furtive Rescue: everything needed to take your money out of the Furtive vault
// with nothing but your 12 words. No Furtive server is involved at any step:
// it reads the blockchain directly, makes the proofs on this device, and sends
// the withdrawals itself, paying the network fee from your own drop-off address
// (which comes from the same 12 words).
import { createPublicClient, createWalletClient, defineChain, formatUnits, getAddress, http, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem'
import { openData } from '@sdk/orders.mjs'
import { privateKeyToAccount } from 'viem/accounts'
import { accountFromPhrase, decoyNote } from '@sdk/wallet.mjs'
import { readVault, findNotes } from '@sdk/chain.mjs'
import { proveTransact } from '@sdk/index.mjs'

export type Network = { chainId: number; rpc: string; vault: Address; fromBlock: bigint; explorer: string }

// Robinhood Chain testnet. Every value can be changed on the page, so the tool
// keeps working even if an address here ever goes out of date.
export const DEFAULT_NETWORK: Network = {
  chainId: 46630,
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  vault: '0x75843C1a45D75F3a1768DbBD191DC7939E3731f5',
  fromBlock: 157178232n,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
}

const ZERO: Address = '0x0000000000000000000000000000000000000000'
const ERC20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const VAULT_ABI = parseAbi([
  'struct ExtData { address recipient; address relayer; uint256 relayerFee; address adapter; address assetOut; uint256 minOut; uint256 outNpk; uint256 deadline; bytes adapterData; bytes[2] encryptedOutputs; bytes encryptedSwapNote; }',
  'struct Proof { uint256[2] a; uint256[2][2] b; uint256[2] c; }',
  'struct Transaction { uint256 root; uint256 treeDepth; address asset; uint256 publicAmount; uint256[2] nullifiers; uint256[2] commitments; }',
  'function extDataHash(ExtData ext) pure returns (uint256)',
  'function transact(Proof proof, Transaction t, ExtData ext)',
])

type Note = { commitment: bigint; index: bigint; asset: bigint; amount: bigint; blinding: bigint; sk: bigint }
export type Holding = { asset: Address; symbol: string; decimals: number; amount: bigint; notes: Note[] }
/** An open private order (limit or stop-loss): cancelled first, so its funds come back. */
export type OpenOrder = { id: bigint; asset: Address; symbol: string; decimals: number; amount: bigint; terms: unknown; cancelKey: `0x${string}`; backSealed: `0x${string}` }
export type Found = {
  holdings: Holding[]
  orders: OpenOrder[]
  /** your drop-off address: pays the network fee for each withdrawal */
  feeAddress: Address
  feeBalance: bigint
  /** network fee for one withdrawal right now, with room to spare */
  feePerWithdrawal: bigint
}
export type ProofFiles = { wasm: unknown; zkey: unknown }

const clients = (net: Network) => {
  const chain = defineChain({ id: net.chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [net.rpc] } } })
  return { chain, pub: createPublicClient({ chain, transport: http(net.rpc), pollingInterval: 500 }) as PublicClient }
}

const assetAddress = (a: bigint) => getAddress('0x' + a.toString(16).padStart(40, '0'))

/** Opens the account from its 12 words and finds every note it still owns in the vault. */
export async function find(phrase: string, net: Network): Promise<Found & { account: Awaited<ReturnType<typeof accountFromPhrase>> }> {
  const account = await accountFromPhrase(phrase)
  const { pub } = clients(net)
  const feeAddress = privateKeyToAccount(account.depositKey as `0x${string}`).address
  const [state, feeBalance, gasPrice] = await Promise.all([readVault(pub, net.vault, net.fromBlock), pub.getBalance({ address: feeAddress }), pub.getGasPrice()])
  const feePerWithdrawal = 900_000n * gasPrice * 2n
  const notes = (await findNotes(account, state)) as Note[]
  const orders = await findOrders(pub, net, account.viewKey)
  const byAsset = new Map<bigint, Note[]>()
  for (const n of notes) byAsset.set(n.asset, [...(byAsset.get(n.asset) ?? []), n])
  const holdings: Holding[] = []
  for (const [a, list] of byAsset) {
    const asset = assetAddress(a)
    let symbol = 'ETH'
    let decimals = 18
    if (a !== 0n) {
      symbol = await pub.readContract({ address: asset, abi: ERC20, functionName: 'symbol' }).catch(() => 'TOKEN')
      decimals = await pub.readContract({ address: asset, abi: ERC20, functionName: 'decimals' }).then(Number).catch(() => 18)
    }
    holdings.push({ asset, symbol, decimals, amount: list.reduce((s, n) => s + n.amount, 0n), notes: list.sort((x, y) => (x.amount > y.amount ? -1 : 1)) })
  }
  holdings.sort((x, y) => (x.asset === ZERO ? -1 : y.asset === ZERO ? 1 : 0))
  return { account, holdings, orders, feeAddress, feeBalance, feePerWithdrawal }
}

const PLACED = parseAbiItem('event OrderPlaced(uint256 indexed id, address indexed asset, uint256 amount, bytes sealedTerms)')
const ORDERS_ABI = parseAbi([
  'function orders(uint256 id) view returns (address asset, uint256 amount, uint256 termsHash)',
  'struct OrderTerms { address assetOut; uint256 minOut; uint256 outNpk; bytes32 outNoteHash; uint256 cancelNpk; bytes32 cancelNoteHash; bytes32 cancelKeyHash; uint64 expiry; uint8 trigger; bytes32 poolId; uint160 triggerSqrtPrice; uint256 fillerFee; uint256 salt; }',
  'function cancelOrder(uint256 id, OrderTerms terms, bytes32 cancelKey, bytes encryptedNote)',
])

/**
 * Your open orders. Every order carries its terms sealed to your view key, so the
 * 12 words alone recognise it; one still holding funds on the vault is open.
 */
async function findOrders(pub: PublicClient, net: Network, viewKey: CryptoKey): Promise<OpenOrder[]> {
  const latest = await pub.getBlockNumber()
  const logs = []
  for (let from = net.fromBlock; from <= latest; from += 5_000_000n) {
    const to = from + 4_999_999n > latest ? latest : from + 4_999_999n
    logs.push(...(await pub.getLogs({ address: net.vault, event: PLACED, fromBlock: from, toBlock: to })))
  }
  const mine: OpenOrder[] = []
  for (const l of logs) {
    const rec = (await openData(viewKey, l.args.sealedTerms as `0x${string}`)) as { terms: unknown; cancelKey: `0x${string}`; backSealed: `0x${string}` } | null
    if (!rec) continue
    const [asset, amount] = (await pub.readContract({ address: net.vault, abi: ORDERS_ABI, functionName: 'orders', args: [l.args.id as bigint] })) as [Address, bigint, bigint]
    if (amount === 0n) continue // filled or cancelled already
    let symbol = 'ETH'
    let decimals = 18
    if (asset !== ZERO) {
      symbol = await pub.readContract({ address: asset, abi: ERC20, functionName: 'symbol' }).catch(() => 'TOKEN')
      decimals = await pub.readContract({ address: asset, abi: ERC20, functionName: 'decimals' }).then(Number).catch(() => 18)
    }
    mine.push({ id: l.args.id as bigint, asset, symbol, decimals, amount, terms: rec.terms, cancelKey: rec.cancelKey, backSealed: rec.backSealed })
  }
  return mine
}

export const show = (amount: bigint, decimals: number) => {
  const [i, d = ''] = formatUnits(amount, decimals).split('.')
  const dec = d.slice(0, 6).replace(/0+$/, '')
  return dec ? `${i}.${dec}` : i
}

export type Step = { label: string; state: 'waiting' | 'working' | 'done' | 'failed'; hash?: string; error?: string }

/**
 * Sends everything to `to`. Each withdrawal spends at most two notes, so a balance
 * spread over many notes takes several withdrawals; each one is proven here and
 * sent from the drop-off address, which pays its network fee.
 */
export async function rescue(
  phrase: string,
  to: Address,
  net: Network,
  files: ProofFiles,
  onStep: (steps: Step[]) => void,
): Promise<Step[]> {
  let { account, holdings, orders } = await find(phrase, net)
  const { chain, pub } = clients(net)
  const signer = privateKeyToAccount(account.depositKey as `0x${string}`)
  const wallet = createWalletClient({ chain, transport: http(net.rpc), account: signer })

  // 1. Open orders first: cancelling returns their funds as notes in your balance.
  const cancels: Step[] = orders.map((o) => ({ label: `Cancel order: ${show(o.amount, o.decimals)} ${o.symbol}`, state: 'waiting' }))
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]
    cancels[i] = { ...cancels[i], state: 'working' }
    onStep([...cancels])
    try {
      const { request } = await pub.simulateContract({ address: net.vault, abi: ORDERS_ABI, functionName: 'cancelOrder', args: [o.id, o.terms as never, o.cancelKey, o.backSealed], account: signer })
      const hash = await wallet.writeContract(request)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== 'success') throw new Error('The network rejected this cancel.')
      cancels[i] = { ...cancels[i], state: 'done', hash }
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string }
      const msg = err.shortMessage || err.message || 'failed'
      cancels[i] = { ...cancels[i], state: 'failed', error: /insufficient funds|exceeds the balance/i.test(msg) ? 'Not enough ETH at your drop-off address for the network fee.' : msg.slice(0, 200) }
      onStep([...cancels])
      return cancels
    }
    onStep([...cancels])
  }
  // what the cancels gave back is now in your balance
  if (orders.length) ({ holdings } = await find(phrase, net))

  // plan: one step per pair of notes
  const plan: { holding: Holding; notes: Note[] }[] = []
  for (const h of holdings) for (let i = 0; i < h.notes.length; i += 2) plan.push({ holding: h, notes: h.notes.slice(i, i + 2) })
  const steps: Step[] = [
    ...cancels,
    ...plan.map(({ holding, notes }) => ({
      label: `${show(notes.reduce((s, n) => s + n.amount, 0n), holding.decimals)} ${holding.symbol}`,
      state: 'waiting' as const,
    })),
  ]
  const at = cancels.length // withdrawal i is step at + i
  onStep([...steps])

  for (let i = 0; i < plan.length; i++) {
    const { holding, notes } = plan[i]
    steps[at + i] = { ...steps[at + i], state: 'working' }
    onStep([...steps])
    try {
      const amount = notes.reduce((s, n) => s + n.amount, 0n)
      const ext = {
        recipient: getAddress(to),
        relayer: ZERO,
        relayerFee: 0n,
        adapter: ZERO,
        assetOut: ZERO,
        minOut: 0n,
        outNpk: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
        adapterData: '0x' as const,
        encryptedOutputs: [decoyNote(), decoyNote()] as readonly [`0x${string}`, `0x${string}`],
        encryptedSwapNote: '0x' as const,
      }
      // the tree as it is now, including notes made by the previous withdrawal
      const [state, extDataHash] = await Promise.all([
        readVault(pub, net.vault, net.fromBlock),
        pub.readContract({ address: net.vault, abi: VAULT_ABI, functionName: 'extDataHash', args: [ext] }),
      ])
      const { proof, tx } = (await proveTransact({
        wasm: files.wasm,
        zkey: files.zkey,
        leaves: state.leaves.map((l: { commitment: bigint }) => l.commitment),
        asset: holding.asset,
        inputs: notes,
        outputs: [],
        publicAmount: amount,
        extDataHash,
      })) as { proof: { a: [bigint, bigint]; b: [[bigint, bigint], [bigint, bigint]]; c: [bigint, bigint] }; tx: { root: bigint; treeDepth: bigint; asset: Address; publicAmount: bigint; nullifiers: [bigint, bigint]; commitments: [bigint, bigint] } }
      const { request } = await pub.simulateContract({ address: net.vault, abi: VAULT_ABI, functionName: 'transact', args: [proof, tx, ext], account: signer })
      const hash = await wallet.writeContract(request)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== 'success') throw new Error('The network rejected this withdrawal.')
      steps[at + i] = { ...steps[at + i], state: 'done', hash }
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string }
      const msg = err.shortMessage || err.message || 'failed'
      steps[at + i] = { ...steps[at + i], state: 'failed', error: /insufficient funds|exceeds the balance/i.test(msg) ? 'Not enough ETH at your drop-off address for the network fee.' : msg.slice(0, 200) }
      onStep([...steps])
      return steps
    }
    onStep([...steps])
  }
  return steps
}

/** Sends whatever ETH is sitting at the drop-off address to `to`, keeping only the fee. */
export async function sweepDropOff(phrase: string, to: Address, net: Network): Promise<string | null> {
  const account = await accountFromPhrase(phrase)
  const { chain, pub } = clients(net)
  const signer = privateKeyToAccount(account.depositKey as `0x${string}`)
  const wallet = createWalletClient({ chain, transport: http(net.rpc), account: signer })
  const [balance, fees] = await Promise.all([pub.getBalance({ address: signer.address }), pub.estimateFeesPerGas()])
  const fee = 21_000n * (fees.maxFeePerGas ?? 0n) * 2n
  if (balance <= fee) return null
  const hash = await wallet.sendTransaction({ to: getAddress(to), value: balance - fee, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
  await pub.waitForTransactionReceipt({ hash })
  return hash
}
