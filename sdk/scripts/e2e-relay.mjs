// End-to-end on Robinhood Chain testnet, as a real user would do it:
// new phrase -> fund the deposit wallet -> deposit -> find the note on chain ->
// prove a private withdrawal on this device -> relayer submits -> find the change.
//   node scripts/e2e-relay.mjs   (relayer running at RELAYER_URL)
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, defineChain, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNote, proveTransact, randomField } from '../src/index.mjs'
import { newPhrase, accountFromPhrase, sealNote, decoyNote } from '../src/wallet.mjs'
import { readVault, findNotes, balances } from '../src/chain.mjs'

const RPC = 'https://rpc.testnet.chain.robinhood.com'
const VAULT = '0x75843C1a45D75F3a1768DbBD191DC7939E3731f5'
const FROM_BLOCK = 157178232n
const RELAYER_URL = process.env.RELAYER_URL || 'http://127.0.0.1:8787'
const ZERO = '0x0000000000000000000000000000000000000000'
const chain = defineChain({ id: 46630, name: 'RH testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })
const abi = JSON.parse(readFileSync('../contracts/out/FurtiveVault.sol/FurtiveVault.json', 'utf8')).abi
const env = Object.fromEntries(readFileSync('../contracts/.env', 'utf8').trim().split('\n').map((l) => l.split('=')))

const t0 = Date.now()
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

// 1. a brand-new account
const phrase = newPhrase()
const acct = await accountFromPhrase(phrase)
const depositWallet = privateKeyToAccount(acct.depositKey)
step(`new account, deposit wallet ${depositWallet.address}`)

// 2. the user funds their deposit wallet from anywhere (here: our testnet deployer)
const funder = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(env.DEPLOYER_PK) })
await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: depositWallet.address, value: parseEther('0.00012') }) })
step('deposit wallet funded with 0.00012 ETH')

// 3. deposit 0.0003 ETH into the vault as a private note
const note = await createNote({ pk: acct.pk, asset: ZERO, amount: parseEther('0.0001') })
const user = createWalletClient({ chain, transport: http(RPC), account: depositWallet })
const dep = await user.writeContract({ address: VAULT, abi, functionName: 'deposit', args: [ZERO, parseEther('0.0001'), note.npk, await sealNote(acct.viewKey, note)], value: parseEther('0.0001') })
await pub.waitForTransactionReceipt({ hash: dep })
step(`deposited: ${dep}`)

// 4. find our notes by scanning the chain with only the phrase-derived keys
let state = await readVault(pub, VAULT, FROM_BLOCK)
let mine = await findNotes(acct, state)
step(`scanned ${state.leaves.length} leaves, found ${mine.length} note(s) of ours: ${mine.map((n) => formatEther(n.amount)).join(', ')} ETH`)

// 5. prove a private withdrawal of 0.0004 ETH to a brand-new wallet, keeping 0.0006 as change
const fresh = privateKeyToAccount('0x' + randomField().toString(16).padStart(64, '0')).address
const change = await createNote({ pk: acct.pk, asset: ZERO, amount: parseEther('0.00006') })
const info = await (await fetch(`${RELAYER_URL}/info`)).json()
const ext = {
  recipient: fresh, relayer: info.relayer, relayerFee: 0n, adapter: ZERO, assetOut: ZERO, minOut: 0n, outNpk: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), adapterData: '0x',
  encryptedOutputs: [await sealNote(acct.viewKey, change), decoyNote()], encryptedSwapNote: '0x',
}
const extDataHash = await pub.readContract({ address: VAULT, abi, functionName: 'extDataHash', args: [ext] })
const { proof, tx } = await proveTransact({
  wasm: '../circuits/build/transact_js/transact.wasm', zkey: '../circuits/build/transact_dev.zkey',
  leaves: state.leaves.map((l) => l.commitment), asset: ZERO,
  inputs: [mine[mine.length - 1]], outputs: [{ npk: change.npk, amount: change.amount }],
  publicAmount: parseEther('0.00004'), extDataHash,
})
step('proof made on this device')

// 6. the relayer submits it; the user's wallets never touch this transaction
const s = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))
const res = await (await fetch(`${RELAYER_URL}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof: s(proof), tx: s(tx), ext: s(ext) }) })).json()
if (!res.hash) throw new Error('relay failed: ' + res.error)
const rc = await pub.waitForTransactionReceipt({ hash: res.hash })
step(`relayed: ${res.hash} (sent by ${rc.from}, status ${rc.status})`)

// 7. rescan: the spent note is gone, the change is found
state = await readVault(pub, VAULT, FROM_BLOCK)
mine = await findNotes(acct, state)
const bal = balances(mine)
step(`private balance now ${formatEther(bal.get(0n) ?? 0n)} ETH; fresh wallet holds ${formatEther(await pub.getBalance({ address: fresh }))} ETH`)
process.exit(0)
