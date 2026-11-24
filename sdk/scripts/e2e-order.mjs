// Live private orders on Robinhood Chain testnet, the way the app makes them:
// a fresh account deposits, places a limit buy that the live order-watcher fills,
// places a second order and cancels it through the relayer.
//   node scripts/e2e-order.mjs   (DEPLOYER_PK in ../contracts/.env funds the test account)
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, formatEther, keccak256, parseAbi, parseEther, toHex, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNote, proveTransact } from '../src/index.mjs'
import { accountFromPhrase, newPhrase, sealNote, decoyNote } from '../src/wallet.mjs'
import { readVault, findNotes, balances } from '../src/chain.mjs'
import { prepareOrder, TRIGGER } from '../src/orders.mjs'

const RPC = 'https://rpc.testnet.chain.robinhood.com'
const RELAYER = 'https://furtive-relayer.furtivehq.workers.dev'
const VAULT = '0x75843C1a45D75F3a1768DbBD191DC7939E3731f5'
const FROM = 157178232n
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const QUOTER = '0x520B8fC1a687eeD97Ad4015c4242A2111d8332aE'
const PEEK = '0xAe3917FD6bF7cf6dD378cd4ba3110BeEd841959f'
const ZERO = '0x0000000000000000000000000000000000000000'
const POOL = { currency0: ZERO, currency1: PEEK, fee: 3000, tickSpacing: 60, hooks: ZERO }
const POOL_KEY = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }]
const ORDER_BOOK = getAddress(`0x${keccak256(toHex('furtive.orders')).slice(-40)}`)

const env = Object.fromEntries(readFileSync('../contracts/.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const chain = defineChain({ id: 46630, name: 'RH testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })
const abi = JSON.parse(readFileSync('../contracts/out/FurtiveVault.sol/FurtiveVault.json', 'utf8')).abi
const qabi = JSON.parse(readFileSync('../contracts/out/FurtiveQuoter.sol/FurtiveQuoter.json', 'utf8')).abi
const t0 = Date.now()
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
const s = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))
const post = async (path, body) => (await fetch(`${RELAYER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s(body)) })).json()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1. a fresh account, funded and deposited
const acct = await accountFromPhrase(newPhrase())
const dropoff = privateKeyToAccount(acct.depositKey)
const funder = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(env.DEPLOYER_PK) })
await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: dropoff.address, value: parseEther('0.0032') }) })
const note = await createNote({ pk: acct.pk, asset: ZERO, amount: parseEther('0.003') })
const dw = createWalletClient({ chain, transport: http(RPC), account: dropoff })
await pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: VAULT, abi, functionName: 'deposit', args: [ZERO, note.amount, note.npk, await sealNote(acct.viewKey, note)], value: note.amount }) })
step('fresh account deposited 0.003 ETH into the new vault')

const sqrtNow = async () => {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [keccak256(encodeAbiParameters(POOL_KEY, Object.values(POOL))), 6n]))
  return BigInt(await pub.readContract({ address: PM, abi: parseAbi(['function extsload(bytes32) view returns (bytes32)']), functionName: 'extsload', args: [slot] })) & ((1n << 160n) - 1n)
}
const poolId = keccak256(encodeAbiParameters(POOL_KEY, Object.values(POOL)))

/** Places an order with a real proof, through the live relayer, and registers it. */
async function place(amount, order) {
  const state = await readVault(pub, VAULT, FROM)
  const eth = (await findNotes(acct, state)).filter((n) => n.asset === 0n).sort((a, b) => (a.amount > b.amount ? -1 : 1))[0]
  const prep = await prepareOrder(acct, { assetIn: ZERO, amount, ...order })
  const change = await createNote({ pk: acct.pk, asset: ZERO, amount: eth.amount - amount })
  const info = await (await fetch(`${RELAYER}/info`)).json()
  for (const [k, v] of Object.entries({ relayer: info.relayer, ORDER_BOOK, ZERO })) if (!v) throw new Error(`missing ${k}: ${JSON.stringify(info)}`)
  const ext = {
    recipient: ZERO, relayer: info.relayer, relayerFee: 0n, adapter: ORDER_BOOK, assetOut: ZERO, minOut: 0n, outNpk: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600), adapterData: prep.adapterData,
    encryptedOutputs: [await sealNote(acct.viewKey, change), decoyNote()], encryptedSwapNote: '0x',
  }
  const extDataHash = await pub.readContract({ address: VAULT, abi, functionName: 'extDataHash', args: [ext] })
  const { proof, tx } = await proveTransact({
    wasm: '../circuits/build/transact_js/transact.wasm', zkey: '../circuits/build/transact_dev.zkey',
    leaves: state.leaves.map((l) => l.commitment), asset: ZERO, inputs: [eth], outputs: [{ npk: change.npk, amount: change.amount }], publicAmount: amount, extDataHash,
  })
  const res = await post('/relay', { proof, tx, ext })
  if (!res.hash || !res.orderId) throw new Error('placing failed: ' + JSON.stringify(res))
  const reg = await post('/orders', { id: res.orderId, terms: prep.terms, outSealed: prep.outSealed, backSealed: prep.backSealed, route: [POOL] })
  if (reg.error) throw new Error('register failed: ' + reg.error)
  return { id: res.orderId, hash: res.hash, prep }
}

// 2. a limit buy whose price is already met: the watcher should fill it within a minute or two
const amountA = parseEther('0.001')
const { result: q } = await pub.simulateContract({ address: QUOTER, abi: qabi, functionName: 'quote', args: [ZERO, amountA - (amountA * 30n) / 10_000n, [POOL]] })
const now = await sqrtNow()
const a = await place(amountA, { assetOut: PEEK, minOut: (q[1] * 95n) / 100n, expiry: Math.floor(Date.now() / 1000) + 3600, trigger: TRIGGER.atOrAbove, poolId, triggerSqrtPrice: (now * 999n) / 1000n })
step(`limit buy placed privately: order ${a.id}, tx ${a.hash}, registered with the watcher`)

// 3. a second order far from its price, to cancel
const b = await place(parseEther('0.001'), { assetOut: PEEK, minOut: 1n, expiry: Math.floor(Date.now() / 1000) + 86400, trigger: TRIGGER.atOrAbove, poolId, triggerSqrtPrice: now * 2n })
step(`second order placed: ${b.id}`)
const c = await post(`/orders/${b.id}/cancel`, { terms: b.prep.terms, cancelKey: b.prep.cancelKey, backSealed: b.prep.backSealed })
step(`cancelled through the relayer: ${c.hash} confirmed=${c.confirmed}`)

// 4. wait for the watcher
for (let i = 0; i < 24; i++) {
  const st = await (await fetch(`${RELAYER}/orders/${a.id}`)).json()
  if (st.status === 'filled') {
    step(`order ${a.id} FILLED by the watcher: ${st.tx}`)
    break
  }
  if (i === 23) throw new Error('not filled after 4 minutes: ' + JSON.stringify(st))
  await sleep(10_000)
}

const bal = balances(await findNotes(acct, await readVault(pub, VAULT, FROM)))
step(`12 words see: ${formatEther(bal.get(0n) ?? 0n)} ETH (0.001 change + 0.001 from the cancel) and ${formatEther(bal.get(BigInt(PEEK)) ?? 0n)} PEEK from the fill`)
process.exit(0)
