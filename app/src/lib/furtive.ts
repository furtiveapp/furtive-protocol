// What the app does with the vault: read the private balance, add funds, send out.
import { createPublicClient, createWalletClient, encodeAbiParameters, http, parseAbi, getAddress, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNote } from '@sdk/core.mjs'
import { sealNote, decoyNote, type Account } from '@sdk/wallet.mjs'
import { readVault, findNotes, balances, type OwnedNote } from '@sdk/chain.mjs'
import { CHAIN, VAULT, VAULT_FROM_BLOCK, RELAYER_URL, ETH, GAS_RESERVE, ZK, ADAPTER } from './config'
import { POOL_KEY, type PoolKey } from './market'

// Robinhood Chain makes a block about every quarter second, so look for results that often.
export const client = createPublicClient({ chain: CHAIN, transport: http(undefined, { batch: { wait: 16 } }), pollingInterval: 250 })

const VAULT_ABI = parseAbi([
  'function deposit(address asset, uint256 amount, uint256 npk, bytes encryptedNote) payable returns (uint256, uint256)',
  'function depositLimits(address asset) view returns (uint256 perDeposit, uint256 total)',
  'function held(address asset) view returns (uint256)',
  'struct ExtData { address recipient; address relayer; uint256 relayerFee; address adapter; address assetOut; uint256 minOut; uint256 outNpk; uint256 deadline; bytes adapterData; bytes[2] encryptedOutputs; bytes encryptedSwapNote; }',
  'function extDataHash(ExtData ext) pure returns (uint256)',
])

export type Wallet = { notes: OwnedNote[]; balance: Map<bigint, bigint>; depositAddress: Address; depositBalance: bigint }

/** Everything the home screen shows, read fresh from the chain. */
export async function loadWallet(account: Account): Promise<Wallet> {
  const depositAddress = privateKeyToAccount(account.depositKey).address
  const [state, depositBalance] = await Promise.all([
    vault(true),
    client.getBalance({ address: depositAddress }),
  ])
  const notes = await findNotes(account, state)
  return { notes, balance: balances(notes), depositAddress, depositBalance }
}

/** How much of the deposit wallet can go in right now. */
export async function depositable(depositBalance: bigint) {
  const [per, total] = await client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'depositLimits', args: [ETH] })
  const held = await client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'held', args: [ETH] })
  const room = total > held ? total - held : 0n
  const free = depositBalance > GAS_RESERVE ? depositBalance - GAS_RESERVE : 0n
  return [free, per, room].reduce((a, b) => (b < a ? b : a))
}

/** Moves ETH from the deposit wallet into the vault as a private note. */
export async function addFunds(account: Account, amount: bigint) {
  const signer = privateKeyToAccount(account.depositKey)
  const wallet = createWalletClient({ chain: CHAIN, transport: http(), account: signer })
  const note = await createNote({ pk: account.pk, asset: ETH, amount })
  const hash = await wallet.writeContract({
    address: VAULT,
    abi: VAULT_ABI,
    functionName: 'deposit',
    args: [ETH, amount, note.npk, await sealNote(account.viewKey, note)],
    value: amount,
  })
  await client.waitForTransactionReceipt({ hash })
  return hash
}

/** Picks at most two notes that cover `amount`, largest first. */
function pick(notes: OwnedNote[], asset: bigint, amount: bigint): OwnedNote[] {
  const mine = notes.filter((n) => n.asset === asset).sort((a, b) => (a.amount > b.amount ? -1 : 1))
  const one = [...mine].reverse().find((n) => n.amount >= amount)
  if (one) return [one]
  if (mine.length >= 2 && mine[0].amount + mine[1].amount >= amount) return [mine[0], mine[1]]
  throw new Error(mine.length > 2 ? 'Your balance is spread across several notes. Combine them first.' : 'Not enough private balance.')
}

// One proof worker for the whole session, warmed up when the app opens.
let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
function proofWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./prove.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id)
    if (!w) return
    waiting.delete(e.data.id)
    e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error))
  }
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'The proof could not be made.'))
    waiting.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}
function ask<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++nextId
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    proofWorker().postMessage({ id, ...msg })
  })
}

/** Downloads the proof files in the background, so the first trade does not wait for them. */
export const warmUp = () => {
  ask({ warm: [ZK.wasm, ZK.zkey] }).catch(() => {})
  relayerInfo().catch(() => {})
}

const prove = (params: unknown) => ask<{ proof: unknown; tx: Record<string, unknown> }>({ params })

// The relayer's address does not change during a session.
let info: Promise<{ relayer?: string; error?: string }> | null = null
// Asked a few times before giving up, so a busy moment on the network never stops a trade.
async function askInfo() {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try {
      const j = await fetch(`${RELAYER_URL}/info`).then((r) => r.json())
      if (j.relayer) return j
      last = new Error(j.error || 'relayer not configured')
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)))
  }
  throw last
}
const relayerInfo = () =>
  (info ??= askInfo().catch((e) => {
    info = null
    throw e
  }))

// The pool's notes, kept from the last read. A trade reuses them when the pool has
// not changed since, instead of reading its whole history again.
let lastVault: Awaited<ReturnType<typeof readVault>> | null = null
async function vault(fresh = false) {
  if (lastVault && !fresh) {
    const size = await client.readContract({ address: VAULT, abi: TREE_SIZE_ABI, functionName: 'treeSize' })
    if (BigInt(lastVault.leaves.length) === size) return lastVault
  }
  lastVault = await readVault(client, VAULT, VAULT_FROM_BLOCK)
  return lastVault
}
const TREE_SIZE_ABI = parseAbi(['function treeSize() view returns (uint256)'])

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)))

export { relayerInfo }
export type Stage = 'preparing' | 'proving' | 'sending' | 'done'

type Ext = {
  recipient: Address
  relayer: Address
  relayerFee: bigint
  adapter: Address
  assetOut: Address
  minOut: bigint
  outNpk: bigint
  deadline: bigint
  adapterData: `0x${string}`
  encryptedOutputs: readonly [`0x${string}`, `0x${string}`]
  encryptedSwapNote: `0x${string}`
}

/**
 * Spends notes of `asset` with a proof made on this device, releases `amount`
 * as `ext` says (to a wallet, or into a swap), and keeps the change as a new
 * private note. The relayer only delivers it and pays the gas.
 */
// While a private transaction is in flight the chain is half-updated; balance
// refreshes wait until it lands, so the number never jumps through odd values.
let inFlight = 0
export const txInFlight = () => inFlight > 0

export async function privateTx(
  account: Account,
  notes: OwnedNote[],
  asset: Address,
  amount: bigint,
  makeExt: (relayer: Address, sealed: readonly [`0x${string}`, `0x${string}`]) => Promise<Ext>,
  onStage: (s: Stage) => void,
) {
  inFlight++
  try {
    return await privateTxInner(account, notes, asset, amount, makeExt, onStage)
  } finally {
    inFlight--
  }
}

async function privateTxInner(
  account: Account,
  notes: OwnedNote[],
  asset: Address,
  amount: bigint,
  makeExt: (relayer: Address, sealed: readonly [`0x${string}`, `0x${string}`]) => Promise<Ext>,
  onStage: (s: Stage) => void,
) {
  onStage('preparing')
  const inputs = pick(notes, BigInt(asset), amount)
  const total = inputs.reduce((s, n) => s + n.amount, 0n)
  const changeAmount = total - amount

  const info = await relayerInfo()
  if (!info.relayer) throw new Error(info.error || 'relayer not configured')
  const outputs: { npk: bigint; amount: bigint }[] = []
  const sealed: `0x${string}`[] = []
  if (changeAmount > 0n) {
    const change = await createNote({ pk: account.pk, asset, amount: changeAmount })
    outputs.push({ npk: change.npk, amount: change.amount })
    sealed.push(await sealNote(account.viewKey, change))
  }
  while (sealed.length < 2) sealed.push(decoyNote())

  const ext = await makeExt(getAddress(info.relayer), [sealed[0], sealed[1]] as const)
  const extDataHash = await client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'extDataHash', args: [ext] })

  // If sending fails for a reason that is not the person's (the pool moved on, or the
  // network dropped a request), read the pool fresh and try once more by itself.
  let body: { hash?: string; confirmed?: boolean; reverted?: boolean; error?: string; orderId?: string } = {}
  for (let attempt = 0; attempt < 2; attempt++) {
    // a retry keeps the step already on screen, so progress never jumps backwards
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500))
    const state = await vault(attempt > 0)
    if (attempt === 0) onStage('proving')
    const { proof, tx } = await prove({
      wasm: ZK.wasm,
      zkey: ZK.zkey,
      leaves: state.leaves.map((l) => l.commitment),
      asset,
      inputs,
      outputs,
      publicAmount: amount,
      extDataHash,
    })

    if (attempt === 0) onStage('sending')
    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: json(proof), tx: json(tx), ext: json(ext) }),
    }).catch(() => null)
    body = res ? await res.json().catch(() => ({ error: 'The relayer did not answer.' })) : { error: 'The relayer did not answer.' }
    if (body.hash) break
    if (/country|not available/i.test(body.error || '')) break
  }
  if (!body.hash) throw new Error(body.error || 'The relayer could not send it.')
  if (body.reverted) throw new Error('The trade did not go through. Nothing was spent.')
  if (!body.confirmed) await client.waitForTransactionReceipt({ hash: body.hash as `0x${string}` })
  onStage('done')
  return { hash: body.hash as string, orderId: body.orderId }
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)

/** Sends `amount` of ETH from the private balance to `to`. */
export function sendOut(account: Account, notes: OwnedNote[], amount: bigint, to: string, onStage: (s: Stage) => void) {
  const recipient = getAddress(to)
  return privateTx(account, notes, ETH, amount, async (relayer, sealed) => ({
    recipient,
    relayer,
    relayerFee: 0n,
    adapter: ETH,
    assetOut: ETH,
    minOut: 0n,
    outNpk: 0n,
    deadline: deadline(),
    adapterData: '0x',
    encryptedOutputs: sealed,
    encryptedSwapNote: '0x',
  }), onStage).then((r) => r.hash)
}

/**
 * Trades privately: sells `amountIn` of `assetIn` from the private balance
 * through Uniswap v4 and keeps everything bought as a new private note.
 */
export function trade(
  account: Account,
  notes: OwnedNote[],
  o: { assetIn: Address; amountIn: bigint; assetOut: Address; minOut: bigint; route: PoolKey[] },
  onStage: (s: Stage) => void,
) {
  return privateTx(account, notes, o.assetIn, o.amountIn, async (relayer, sealed) => {
    const out = await createNote({ pk: account.pk, asset: o.assetOut, amount: 0n })
    return {
      recipient: ETH,
      relayer,
      relayerFee: 0n,
      adapter: ADAPTER,
      assetOut: o.assetOut,
      minOut: o.minOut,
      outNpk: out.npk,
      deadline: deadline(),
      adapterData: encodeAbiParameters([{ type: 'tuple[]', components: POOL_KEY }], [o.route]),
      encryptedOutputs: sealed,
      // the amount bought is stated by the chain; the backup only carries the secret
      encryptedSwapNote: await sealNote(account.viewKey, { blinding: out.blinding, amount: 0n, asset: BigInt(o.assetOut) }),
    }
  }, onStage).then((r) => r.hash)
}

// ──────────────────────────────────────────────────────────── Telegram alerts

const BOT = 'https://furtive-bot.furtivehq.workers.dev'
/**
 * Turns Heads up alerts on or off. Sends only the token addresses and symbols you
 * hold, signed by Telegram so the bot knows which chat to message. No wallet, no amounts.
 */
export async function setAlerts(on: boolean, tokens: { address: string; symbol: string }[], signed: string) {
  const r = await fetch(`${BOT}/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: signed, on, tokens }) })
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return j as { on: boolean; watching?: number }
}

/**
 * For a trade you started in the chat: the bot posts the result back there.
 * It sends only what you asked the bot for already (the token and amounts), never
 * the transaction, so the bot still cannot tie your chat to a trade on the chain.
 */
export function sendReceipt(signed: string, r: { side: 'buy' | 'sell'; symbol: string; address: string; spent: string; spentSymbol: string; got: string; gotSymbol: string }) {
  if (!signed) return
  fetch(`${BOT}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: signed, ...r }), keepalive: true }).catch(() => {})
}

// ─────────────────────────────────────────────────────────── price and activity

let priceCache: { usd: number; at: number } | null = null
/** ETH in dollars, through our relayer (cached there), or null if unavailable. */
export async function ethUsd(): Promise<number | null> {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.usd
  try {
    const r = await fetch(`${RELAYER_URL}/price`)
    const j = await r.json()
    if (typeof j.ethUsd === 'number') {
      priceCache = { usd: j.ethUsd, at: Date.now() }
      return j.ethUsd
    }
  } catch {}
  return priceCache?.usd ?? null
}

export type Activity = {
  kind: 'add' | 'send' | 'buy' | 'sell' | 'order'
  /** orders: what was set, like "Stop-loss on TSLA" */
  label?: string
  /** money coming back in (an order cancelled, expired or filled) */
  incoming?: boolean
  amount: string
  to?: string
  symbol?: string
  hash: string
  at: number
  /** trades: what you got, what the next-best route would have paid, and how many routes were compared */
  got?: string
  next?: string
  gain?: string
  outSymbol?: string
  routes?: number
}

/** What this phone has done, newest first. Kept on the device only. */
const activityKey = (account: Account) => `furtive.activity.${account.pk.toString(16).slice(0, 16)}`
export function loadActivity(account: Account): Activity[] {
  try {
    return JSON.parse(localStorage.getItem(activityKey(account)) || '[]')
  } catch {
    return []
  }
}
export function logActivity(account: Account, a: Activity) {
  try {
    const list = [a, ...loadActivity(account)].slice(0, 50)
    localStorage.setItem(activityKey(account), JSON.stringify(list))
  } catch {}
}

/** Turns chain and network errors into something a person can act on. */
export function friendly(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (m.includes('insufficient') || m.includes('exceeds the balance')) return 'Not enough ETH to cover this and its fee.'
  if (m.includes('relayer not configured')) return 'Sending is paused for a moment. Try again shortly.'
  if (m.includes('429') || m.includes('too many') || m.includes('http request failed')) return 'The network is busy right now. Nothing was sent, so try again in a few seconds.'
  if (m.includes('fetch') || m.includes('network') || m.includes('timeout')) return 'Could not reach the network. Check your connection.'
  if (m.includes('notes') && m.includes('spread')) return 'Your balance is split across several notes. Send a smaller amount for now.'
  if (m.includes('not enough private balance')) return 'Not enough private balance.'
  if (m.includes('could not read your balance')) return 'Could not update your balance. It will retry by itself.'
  return 'That did not go through. Nothing was sent, so you can try again.'
}
