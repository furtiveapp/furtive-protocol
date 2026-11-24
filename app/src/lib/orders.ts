// Private limit orders, stop-losses and take-profits.
//
// Placing one is a normal private transaction made on this phone: the amount
// leaves the private balance into an order slot in the vault, and only a
// fingerprint of its terms is stored on the chain. The terms go to the
// order-watcher, which fills the order when the pool's price reaches the
// trigger. The vault checks every term itself, so the watcher cannot change
// anything; proceeds (or the funds, if it is cancelled or expires) come back as
// a private note only this account can open.
import { encodeAbiParameters, getAddress, keccak256, parseAbi, toHex, type Address } from 'viem'
import type { Account } from '@sdk/wallet.mjs'
import type { OwnedNote } from '@sdk/chain.mjs'
import { prepareOrder, TRIGGER } from '@sdk/orders.mjs'
import { ETH, POOL_MANAGER, RELAYER_URL, VAULT } from './config'
import { client, logActivity, privateTx, type Stage } from './furtive'
import { POOL_KEY, quote, units, type PoolKey, type Token } from './market'

/** The vault's ORDER_BOOK marker: address(uint160(uint256(keccak256("furtive.orders")))). */
export const ORDER_BOOK = getAddress(`0x${keccak256(toHex('furtive.orders')).slice(-40)}`)

export type OrderKind = 'limit' | 'stop' | 'take'
export const KIND: Record<OrderKind, { label: string; verb: string; side: 'buy' | 'sell'; up: boolean; slip: bigint; steps: number[] }> = {
  // buy when the price drops
  limit: { label: 'Limit buy', verb: 'Buy', side: 'buy', up: false, slip: 200n, steps: [5, 10, 20] },
  // sell when the price drops: protection, so it accepts more slippage to make sure it fills
  stop: { label: 'Stop-loss', verb: 'Sell', side: 'sell', up: false, slip: 800n, steps: [5, 10, 20] },
  // sell when the price rises
  take: { label: 'Take profit', verb: 'Sell', side: 'sell', up: true, slip: 200n, steps: [10, 25, 50] },
}
export const EXPIRY: [string, number][] = [
  ['1 day', 86_400],
  ['7 days', 7 * 86_400],
  ['30 days', 30 * 86_400],
]

const PM_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)'])
const Q96 = 2n ** 96n

export const poolIdOf = (k: PoolKey) => keccak256(encodeAbiParameters(POOL_KEY, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))

/** The pool's current sqrtPriceX96 (the first 160 bits of its slot0). */
export async function poolSqrtPrice(k: PoolKey): Promise<bigint> {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolIdOf(k), 6n]))
  const word = await client.readContract({ address: POOL_MANAGER, abi: PM_ABI, functionName: 'extsload', args: [slot] })
  return BigInt(word) & ((1n << 160n) - 1n)
}

/** One token's price in ETH from an ETH/token pool's sqrtPriceX96 (ETH is always currency0). */
export function tokenPriceEth(sqrt: bigint, decimals: number) {
  const s = Number(sqrt) / Number(Q96)
  const tokensPerEth = (s * s * 1e18) / 10 ** decimals
  return tokensPerEth > 0 ? 1 / tokensPerEth : 0
}

/** Orders trade through one ETH pool, whose price is the trigger. */
export const orderPool = (t: Token): PoolKey | null => {
  const direct = [t.route, ...t.routes].find((r) => r.length === 1 && r[0].currency0 === ETH)
  return direct?.[0] ?? null
}

export type Plan = {
  kind: OrderKind
  pool: PoolKey
  sqrtNow: bigint
  priceNow: number // token price in ETH
  triggerPrice: number
  trigger: number
  triggerSqrtPrice: bigint
  expected: bigint // what the order returns at the trigger price
  minOut: bigint
}

/**
 * Turns "sell if it drops 10%" into exact terms. The trigger is the pool's own
 * price, so it is read from the same place the vault will check.
 */
export async function planOrder(t: Token, kind: OrderKind, pct: number, amount: bigint): Promise<Plan | null> {
  const pool = orderPool(t)
  if (!pool || pct <= 0 || pct >= 100) return null
  const k = KIND[kind]
  const sqrtNow = await poolSqrtPrice(pool)
  if (sqrtNow === 0n) return null
  const f = k.up ? 1 + pct / 100 : 1 - pct / 100 // the token's price at the trigger, as a share of now
  // a lower token price means more tokens per ETH, so a higher sqrtPrice: and the reverse
  const scale = BigInt(Math.round(Math.sqrt(f) * 1e12))
  const triggerSqrtPrice = (sqrtNow * 1_000_000_000_000n) / scale
  const trigger = k.up ? TRIGGER.atOrBelow : TRIGGER.atOrAbove

  // what the amount fetches now (after the 0.3% fee), moved to the trigger price
  const afterFee = amount - (amount * 30n) / 10_000n
  const now = await quote(k.side === 'buy' ? ETH : t.address, afterFee, [pool])
  if (!now) return null
  const fScaled = BigInt(Math.round(f * 1e6))
  const expected = k.side === 'buy' ? (now * 1_000_000n) / fScaled : (now * fScaled) / 1_000_000n
  const minOut = (expected * (10_000n - k.slip)) / 10_000n
  const priceNow = tokenPriceEth(sqrtNow, t.decimals)
  return { kind, pool, sqrtNow, priceNow, triggerPrice: priceNow * f, trigger, triggerSqrtPrice, expected, minOut }
}

// ───────────────────────────────────────────────────────────── on this phone

export type SavedOrder = {
  id: string | null
  hash: string
  kind: OrderKind
  token: { address: Address; symbol: string; decimals: number; image?: string; stock?: boolean }
  amount: string // in the asset sold, as shown
  pct: number
  triggerPrice: number
  minOut: string
  expiry: number
  at: number
  registered: boolean
  // what a cancel needs; also recoverable from the chain with the 12 words
  terms: string
  cancelKey: `0x${string}`
  backSealed: `0x${string}`
  outSealed: `0x${string}`
  route: string
  status?: string
  /** its ending is in Activity */
  noted?: boolean
}

const key = (a: Account) => `furtive.orders.${a.pk.toString(16).slice(0, 16)}`
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

export function loadOrders(a: Account): SavedOrder[] {
  try {
    return JSON.parse(localStorage.getItem(key(a)) || '[]')
  } catch {
    return []
  }
}
function saveOrders(a: Account, list: SavedOrder[]) {
  try {
    localStorage.setItem(key(a), JSON.stringify(list.slice(0, 50)))
  } catch {}
}
function updateOrder(a: Account, hash: string, patch: Partial<SavedOrder>) {
  saveOrders(a, loadOrders(a).map((o) => (o.hash === hash ? { ...o, ...patch } : o)))
}

const PLACED = keccak256(toHex('OrderPlaced(uint256,address,uint256,bytes)'))
async function orderIdFrom(hash: string): Promise<string | null> {
  const r = await client.waitForTransactionReceipt({ hash: hash as `0x${string}` })
  const log = r.logs.find((l) => l.address.toLowerCase() === VAULT.toLowerCase() && l.topics[0] === PLACED)
  return log?.topics[1] ? BigInt(log.topics[1]).toString() : null
}

/** Hands an order's terms to the order-watcher. Safe to repeat. */
async function register(o: SavedOrder) {
  const r = await fetch(`${RELAYER_URL}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: o.id, terms: JSON.parse(o.terms), outSealed: o.outSealed, backSealed: o.backSealed, route: JSON.parse(o.route) }),
  })
  const j = await r.json().catch(() => ({}))
  if (j.error) throw new Error(j.error)
}

/** Places the order with a proof made on this phone. */
export async function placeOrder(
  account: Account,
  notes: OwnedNote[],
  o: { token: Token; kind: OrderKind; amount: bigint; amountText: string; pct: number; plan: Plan; expiresIn: number },
  onStage: (s: Stage) => void,
) {
  const k = KIND[o.kind]
  const assetIn = k.side === 'buy' ? ETH : o.token.address
  const assetOut = k.side === 'buy' ? o.token.address : ETH
  const expiry = Math.floor(Date.now() / 1000) + o.expiresIn
  const prep = await prepareOrder(account, {
    assetIn, amount: o.amount, assetOut, minOut: o.plan.minOut, expiry,
    trigger: o.plan.trigger, poolId: poolIdOf(o.plan.pool), triggerSqrtPrice: o.plan.triggerSqrtPrice,
  })
  const { hash, orderId } = await privateTx(account, notes, assetIn, o.amount, async (relayer, sealed) => ({
    recipient: ETH, relayer, relayerFee: 0n, adapter: ORDER_BOOK, assetOut: ETH, minOut: 0n, outNpk: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    adapterData: prep.adapterData, encryptedOutputs: sealed, encryptedSwapNote: '0x',
  }), onStage)

  const saved: SavedOrder = {
    id: orderId ?? null, hash, kind: o.kind,
    token: { address: o.token.address, symbol: o.token.symbol, decimals: o.token.decimals, image: o.token.image, stock: o.token.stock },
    amount: o.amountText, pct: o.pct, triggerPrice: o.plan.triggerPrice,
    minOut: o.plan.minOut.toString(), expiry, at: Date.now(), registered: false,
    terms: json(prep.terms), cancelKey: prep.cancelKey, backSealed: prep.backSealed, outSealed: prep.outSealed, route: json([o.plan.pool]),
  }
  saveOrders(account, [saved, ...loadOrders(account)])
  logActivity(account, { kind: 'order', label: `${k.label} on ${o.token.symbol}`, amount: Number(o.amountText).toLocaleString('en-US', { maximumSignificantDigits: 4, maximumFractionDigits: 8 }), symbol: k.side === 'buy' ? 'ETH' : o.token.symbol, hash, at: Date.now() })
  await syncOrders(account) // finds the id if needed, and hands the order to the watcher
  return saved
}

/**
 * Brings this phone's orders up to date: registers any the watcher has not got
 * yet (it retries by itself if the network dropped), and reads each one's status.
 */
export async function syncOrders(account: Account): Promise<SavedOrder[]> {
  // endings that happened before Activity recorded them
  for (const o of loadOrders(account)) {
    if (!o.noted && (o.status === 'cancelled' || o.status === 'returned' || o.status === 'filled')) noteOutcome(account, o, o.status)
  }
  for (const o of loadOrders(account)) {
    try {
      if (!o.id) {
        const id = await orderIdFrom(o.hash)
        if (id) updateOrder(account, o.hash, { id })
        else continue
      }
      const cur = loadOrders(account).find((x) => x.hash === o.hash)!
      if (!cur.registered && !['filled', 'returned', 'cancelled', 'closed'].includes(cur.status ?? '')) {
        await register(cur)
        updateOrder(account, o.hash, { registered: true })
      }
      if (!['filled', 'returned', 'cancelled'].includes(cur.status ?? '')) {
        const s = await fetch(`${RELAYER_URL}/orders/${cur.id}`).then((r) => r.json())
        if (s?.status && s.status !== 'unknown' && s.status !== cur.status) {
          updateOrder(account, o.hash, { status: s.status })
          // a fill or a return is money coming back: it shows in Activity too
          if (s.status === 'filled' || s.status === 'returned') noteOutcome(account, cur, s.status, s.tx)
        }
      }
    } catch {
      // try again next time
    }
  }
  return loadOrders(account)
}

/** Cancels before expiry: the funds come back to the private balance. */
export async function cancelOrder(account: Account, o: SavedOrder) {
  const r = await fetch(`${RELAYER_URL}/orders/${o.id}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ terms: JSON.parse(o.terms), cancelKey: o.cancelKey, backSealed: o.backSealed }),
  })
  const j = await r.json().catch(() => ({ error: 'The relayer did not answer.' }))
  if (j.error) throw new Error(j.error)
  if (j.confirmed) {
    updateOrder(account, o.hash, { status: 'cancelled' })
    noteOutcome(account, o, 'cancelled', j.hash)
  }
  return j as { hash: string; confirmed: boolean }
}

/** An order's ending, in Activity: cancelled or expired brings the funds back; filled brings the proceeds. */
function noteOutcome(account: Account, o: SavedOrder, how: 'cancelled' | 'returned' | 'filled', tx?: string | null) {
  if (loadOrders(account).find((x) => x.hash === o.hash)?.noted) return
  updateOrder(account, o.hash, { noted: true })
  const k = KIND[o.kind]
  const inSymbol = k.side === 'buy' ? 'ETH' : o.token.symbol
  const amount = Number(o.amount).toLocaleString('en-US', { maximumSignificantDigits: 4, maximumFractionDigits: 8 })
  const label = how === 'cancelled' ? `${k.label} on ${o.token.symbol} cancelled` : how === 'returned' ? `${k.label} on ${o.token.symbol} expired` : `${k.label} on ${o.token.symbol} filled`
  if (how === 'filled') {
    const outSymbol = k.side === 'buy' ? o.token.symbol : 'ETH'
    logActivity(account, { kind: 'order', label, amount: `at least ${units(BigInt(o.minOut), k.side === 'buy' ? o.token.decimals : 18, 6)}`, symbol: outSymbol, hash: tx || o.hash, at: Date.now(), incoming: true })
  } else {
    logActivity(account, { kind: 'order', label, amount, symbol: inSymbol, hash: tx || o.hash, at: Date.now(), incoming: true })
  }
}

export const isOpen = (o: SavedOrder) => !['filled', 'returned', 'cancelled', 'closed'].includes(o.status ?? '')
