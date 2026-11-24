// Live test of the rescue tool with an open order, on Robinhood Chain testnet:
// a fresh account deposits and places a private order through the relayer, then the
// rescue tool's own code (app/rescue/rescue.ts) finds the order from the 12 words,
// cancels it, and withdraws everything to an outside address.
//   node scripts/e2e-rescue-order.mjs   (DEPLOYER_PK in ../contracts/.env funds the test)
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, keccak256, parseAbi, parseEther, toHex, getAddress, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNote, proveTransact } from '../src/index.mjs'
import { accountFromPhrase, newPhrase, sealNote, decoyNote } from '../src/wallet.mjs'
import { readVault, findNotes } from '../src/chain.mjs'
import { prepareOrder, TRIGGER } from '../src/orders.mjs'

const RPC = 'https://rpc.testnet.chain.robinhood.com'
const RELAYER = 'https://furtive-relayer.furtivehq.workers.dev'
const VAULT = '0x75843C1a45D75F3a1768DbBD191DC7939E3731f5'
const FROM = 157178232n
const PEEK = '0xAe3917FD6bF7cf6dD378cd4ba3110BeEd841959f'
const ZERO = '0x0000000000000000000000000000000000000000'
const POOL = { currency0: ZERO, currency1: PEEK, fee: 3000, tickSpacing: 60, hooks: ZERO }
const POOL_KEY = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }]
const ORDER_BOOK = getAddress(`0x${keccak256(toHex('furtive.orders')).slice(-40)}`)
const env = Object.fromEntries(readFileSync('../contracts/.env', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const chain = defineChain({ id: 46630, name: 'RH testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 4, retryDelay: 500 }) })
const abi = JSON.parse(readFileSync('../contracts/out/FurtiveVault.sol/FurtiveVault.json', 'utf8')).abi
const s = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))
const post = async (path, body) => (await fetch(`${RELAYER}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s(body)) })).json()
const t0 = Date.now()
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const ok = (c, m) => {
  if (!c) throw new Error('FAILED: ' + m)
  console.log('  ok  ' + m)
}

// 1. a fresh account: 0.002 ETH private, 0.0015 ETH left at the drop-off address for rescue fees
const phrase = newPhrase()
const acct = await accountFromPhrase(phrase)
const dropoff = privateKeyToAccount(acct.depositKey)
const funder = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(env.DEPLOYER_PK) })
await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: dropoff.address, value: parseEther('0.0036') }) })
const note = await createNote({ pk: acct.pk, asset: ZERO, amount: parseEther('0.002') })
const dw = createWalletClient({ chain, transport: http(RPC), account: dropoff })
await pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: VAULT, abi, functionName: 'deposit', args: [ZERO, note.amount, note.npk, await sealNote(acct.viewKey, note)], value: note.amount }) })
step('fresh account deposited 0.002 ETH')

// 2. an order that will not fill: a limit buy far below the price, all of the 0.002
const state = await readVault(pub, VAULT, FROM)
const eth = (await findNotes(acct, state)).find((n) => n.asset === 0n)
const prep = await prepareOrder(acct, { assetIn: ZERO, amount: eth.amount, assetOut: PEEK, minOut: 1n, expiry: Math.floor(Date.now() / 1000) + 86400, trigger: TRIGGER.atOrAbove, poolId: keccak256(encodeAbiParameters(POOL_KEY, Object.values(POOL))), triggerSqrtPrice: 2n ** 159n })
const info = await (await fetch(`${RELAYER}/info`)).json()
const ext = { recipient: ZERO, relayer: info.relayer, relayerFee: 0n, adapter: ORDER_BOOK, assetOut: ZERO, minOut: 0n, outNpk: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), adapterData: prep.adapterData, encryptedOutputs: [decoyNote(), decoyNote()], encryptedSwapNote: '0x' }
const extDataHash = await pub.readContract({ address: VAULT, abi, functionName: 'extDataHash', args: [ext] })
const { proof, tx } = await proveTransact({ wasm: '../circuits/build/transact_js/transact.wasm', zkey: '../circuits/build/transact_dev.zkey', leaves: state.leaves.map((l) => l.commitment), asset: ZERO, inputs: [eth], outputs: [], publicAmount: eth.amount, extDataHash })
const res = await post('/relay', { proof, tx, ext })
ok(res.orderId, `order ${res.orderId} placed privately with all 0.002 ETH`)

// 3. the rescue tool's own code, loaded through Vite
const { createServer } = await import(pathToFileURL('C:/Users/eobi6/furtive/app/node_modules/vite/dist/node/index.js').href)
const server = await createServer({ configFile: 'C:/Users/eobi6/furtive/app/vite.rescue.config.ts', server: { middlewareMode: true }, logLevel: 'error' })
const R = await server.ssrLoadModule('/rescue.ts')
const net = { ...R.DEFAULT_NETWORK, vault: VAULT, fromBlock: FROM }
const found = await R.find(phrase, net)
ok(found.orders.length === 1 && found.orders[0].amount === parseEther('0.002'), 'rescue finds the open order from the 12 words alone')
ok(found.holdings.length === 0, 'and no other balance (it is all in the order)')

const files = { wasm: { type: 'mem', data: new Uint8Array(readFileSync('../circuits/build/transact_js/transact.wasm')) }, zkey: { type: 'mem', data: new Uint8Array(readFileSync('../circuits/build/transact_dev.zkey')) } }
const outside = privateKeyToAccount(env.DEPLOYER_PK).address
const before = await pub.getBalance({ address: outside })
const steps = await R.rescue(phrase, outside, net, files, (st) => step(st.map((x) => `${x.label}: ${x.state}`).join(' | ')))
ok(steps.every((x) => x.state === 'done'), 'every rescue step done: ' + steps.map((x) => x.label).join(', '))
const after = await pub.getBalance({ address: outside })
ok(after - before === parseEther('0.002'), `the full ${formatEther(after - before)} ETH arrived at the outside address`)
const again = await R.find(phrase, net)
ok(again.orders.length === 0 && again.holdings.length === 0, 'nothing left in the vault or in orders')
await server.close()
console.log('all passed')
process.exit(0)
