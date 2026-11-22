// Furtive Rescue: everything needed to take your money out of the Furtive vault
// with nothing but your 12 words. No Furtive server is involved at any step:
// it reads the blockchain directly, makes the proofs on this device, and sends
// the withdrawals itself, paying the network fee from your own drop-off address
// (which comes from the same 12 words).
import { createPublicClient, createWalletClient, defineChain, formatUnits, getAddress, http, parseAbi, type Address, type PublicClient } from 'viem'
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
  vault: '0x4136881594De8661b0d4F005AdAFbce67F2FD018',
  fromBlock: 156050534n,
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
export type Found = {
  holdings: Holding[]
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
  return { account, holdings, feeAddress, feeBalance, feePerWithdrawal }
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
  const { account, holdings } = await find(phrase, net)
  const { chain, pub } = clients(net)
  const signer = privateKeyToAccount(account.depositKey as `0x${string}`)
  const wallet = createWalletClient({ chain, transport: http(net.rpc), account: signer })

  // plan: one step per pair of notes
  const plan: { holding: Holding; notes: Note[] }[] = []
  for (const h of holdings) for (let i = 0; i < h.notes.length; i += 2) plan.push({ holding: h, notes: h.notes.slice(i, i + 2) })
  const steps: Step[] = plan.map(({ holding, notes }) => ({
    label: `${show(notes.reduce((s, n) => s + n.amount, 0n), holding.decimals)} ${holding.symbol}`,
    state: 'waiting',
  }))
  onStep([...steps])

  for (let i = 0; i < plan.length; i++) {
    const { holding, notes } = plan[i]
    steps[i] = { ...steps[i], state: 'working' }
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
      steps[i] = { ...steps[i], state: 'done', hash }
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string }
      const msg = err.shortMessage || err.message || 'failed'
      steps[i] = { ...steps[i], state: 'failed', error: /insufficient funds|exceeds the balance/i.test(msg) ? 'Not enough ETH at your drop-off address for the network fee.' : msg.slice(0, 200) }
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
