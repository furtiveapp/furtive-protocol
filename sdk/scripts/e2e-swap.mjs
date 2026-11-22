// A real private trade on Robinhood Chain testnet, the way the app makes it:
// spend an ETH note, buy PEEK through Uniswap v4, keep the PEEK as a new note.
//   node scripts/e2e-swap.mjs "<12 words>"   (relayer running at RELAYER_URL)
import { readFileSync } from 'node:fs'
import { createPublicClient, http, defineChain, encodeAbiParameters, formatEther, parseEther } from 'viem'
import { createNote, proveTransact } from '../src/index.mjs'
import { accountFromPhrase, sealNote, decoyNote } from '../src/wallet.mjs'
import { readVault, findNotes, balances } from '../src/chain.mjs'

const RPC = 'https://rpc.testnet.chain.robinhood.com'
const VAULT = '0x4136881594De8661b0d4F005AdAFbce67F2FD018'
const ADAPTER = '0xAE13eC8f44F7201764Ba411d716B323DE1174aEe'
const QUOTER = '0x520B8fC1a687eeD97Ad4015c4242A2111d8332aE'
const PEEK = '0x05484528197eE66b5165F61521aA4652d6fA8CB1'
const ZERO = '0x0000000000000000000000000000000000000000'
const FROM = 156050534n
const RELAYER_URL = process.env.RELAYER_URL || 'http://127.0.0.1:8787'
const chain = defineChain({ id: 46630, name: 'RH testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })
const abi = JSON.parse(readFileSync('../contracts/out/FurtiveVault.sol/FurtiveVault.json', 'utf8')).abi
const qabi = JSON.parse(readFileSync('../contracts/out/FurtiveQuoter.sol/FurtiveQuoter.json', 'utf8')).abi
const t0 = Date.now()
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

const acct = await accountFromPhrase(process.argv[2])
let state = await readVault(pub, VAULT, FROM)
let mine = await findNotes(acct, state)
const eth = mine.filter((n) => n.asset === 0n).sort((a, b) => (a.amount > b.amount ? -1 : 1))[0]
step(`private ETH note: ${formatEther(eth.amount)} ETH`)

const amountIn = parseEther('0.00005')
const route = [{ currency0: ZERO, currency1: PEEK, fee: 3000, tickSpacing: 60, hooks: ZERO }]
const fee = (amountIn * 30n) / 10_000n
const { result } = await pub.simulateContract({ address: QUOTER, abi: qabi, functionName: 'quote', args: [ZERO, amountIn - fee, route] })
const minOut = (result[1] * 98n) / 100n
step(`quote: ${formatEther(result[1])} PEEK for ${formatEther(amountIn - fee)} ETH after fee; min ${formatEther(minOut)}`)

const change = await createNote({ pk: acct.pk, asset: ZERO, amount: eth.amount - amountIn })
const out = await createNote({ pk: acct.pk, asset: PEEK, amount: 0n })
const info = await (await fetch(`${RELAYER_URL}/info`)).json()
const ext = {
  recipient: ZERO, relayer: info.relayer, relayerFee: 0n, adapter: ADAPTER, assetOut: PEEK, minOut, outNpk: out.npk,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  adapterData: encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }], [route]),
  encryptedOutputs: [await sealNote(acct.viewKey, change), decoyNote()],
  encryptedSwapNote: await sealNote(acct.viewKey, { blinding: out.blinding, amount: 0n, asset: BigInt(PEEK) }),
}
const extDataHash = await pub.readContract({ address: VAULT, abi, functionName: 'extDataHash', args: [ext] })
const { proof, tx } = await proveTransact({
  wasm: '../circuits/build/transact_js/transact.wasm', zkey: '../circuits/build/transact_dev.zkey',
  leaves: state.leaves.map((l) => l.commitment), asset: ZERO,
  inputs: [eth], outputs: [{ npk: change.npk, amount: change.amount }], publicAmount: amountIn, extDataHash,
})
step('proof made')
const s = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))
const res = await (await fetch(`${RELAYER_URL}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof: s(proof), tx: s(tx), ext: s(ext) }) })).json()
if (!res.hash) throw new Error('relay failed: ' + res.error)
const rc = await pub.waitForTransactionReceipt({ hash: res.hash })
step(`private trade ${res.hash} status ${rc.status}, sent by ${rc.from}`)

state = await readVault(pub, VAULT, FROM)
mine = await findNotes(acct, state)
const bal = balances(mine)
step(`private balance now: ${formatEther(bal.get(0n) ?? 0n)} ETH and ${formatEther(bal.get(BigInt(PEEK)) ?? 0n)} PEEK`)
process.exit(0)
