// Prices, routes and the token check. Everything here only reads the chain.
import { createPublicClient, getAddress, http, isAddress, parseAbi, type Address } from 'viem'
import { client } from './furtive'
import { ETH, LISTED, POOL_MANAGER, QUOTER } from './config'

export const POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

export type Token = { address: Address; symbol: string; name: string; decimals: number; route: PoolKey[]; routes: PoolKey[][]; image?: string; stock?: boolean }

const ERC20 = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function quote(address assetIn, uint256 amountIn, PoolKey[] route) returns (bool ok, uint256 amountOut)',
])

// Common Uniswap v4 fee tiers, tried in order when a token is not listed.
const TIERS: [number, number][] = [
  [3000, 60],
  [10000, 200],
  [500, 10],
  [100, 1],
]

const ethPool = (token: Address, fee: number, tickSpacing: number): PoolKey => ({ currency0: ETH, currency1: token, fee, tickSpacing, hooks: ETH })

/** What `amountIn` of `assetIn` buys along `route`, or null if it cannot fill. */
export async function quote(assetIn: Address, amountIn: bigint, route: PoolKey[]): Promise<bigint | null> {
  if (amountIn <= 0n) return null
  try {
    const { result } = await client.simulateContract({ address: QUOTER, abi: QUOTER_ABI, functionName: 'quote', args: [assetIn, amountIn, route] })
    const [ok, out] = result
    return ok && out > 0n ? out : null
  } catch {
    return null
  }
}

const tokenCache = new Map<string, Token>()

// Tokens a two-hop route may pass through on the way from ETH.
const VIA: Address[] = [getAddress('0x7E955252E15c84f5768B83c41a71F9eba181802F')] // USDG (testnet)

const sortKey = (a: Address, b: Address, fee: number, tickSpacing: number): PoolKey =>
  BigInt(a) < BigInt(b) ? { currency0: a, currency1: b, fee, tickSpacing, hooks: ETH } : { currency0: b, currency1: a, fee, tickSpacing, hooks: ETH }

/** Every pool-route from ETH to `token` that trades right now: direct, and through VIA tokens. */
async function discoverRoutes(token: Address, tiers: [number, number][], twoHop = true): Promise<{ route: PoolKey[]; out: bigint }[]> {
  const probe = 10n ** 13n // 0.00001 ETH: small enough to read the price, not the depth
  const found: { route: PoolKey[]; out: bigint }[] = []
  const tryRoute = async (route: PoolKey[]) => {
    const out = await quote(ETH, probe, route)
    if (out) found.push({ route, out })
  }
  await Promise.all(tiers.map(([fee, ts]) => tryRoute([ethPool(token, fee, ts)])))
  for (const via of twoHop ? VIA : []) {
    if (via.toLowerCase() === token.toLowerCase()) continue
    // the best ETH -> VIA leg first, then every VIA -> token tier after it
    let leg: PoolKey | null = null
    let legOut = 0n
    for (const [fee, ts] of TIERS) {
      const k = sortKey(ETH, via, fee, ts)
      const o = await quote(ETH, probe, [k])
      if (o && o > legOut) (leg = k), (legOut = o)
    }
    if (leg) await Promise.all(TIERS.map(([fee, ts]) => tryRoute([leg as PoolKey, sortKey(via, token, fee, ts)])))
  }
  return found.sort((a, b) => (a.out > b.out ? -1 : 1))
}

/** A token's details and every route that trades it. Null when none does. */
export async function findToken(address: string): Promise<Token | null> {
  if (!isAddress(address)) return null
  const a = getAddress(address)
  const hit = tokenCache.get(a)
  if (hit) return hit
  const listed = LISTED.find((t) => t.address.toLowerCase() === a.toLowerCase())

  let symbol: string, name: string, decimals: number
  try {
    ;[symbol, name, decimals] = await Promise.all([
      client.readContract({ address: a, abi: ERC20, functionName: 'symbol' }),
      client.readContract({ address: a, abi: ERC20, functionName: 'name' }),
      client.readContract({ address: a, abi: ERC20, functionName: 'decimals' }),
    ])
  } catch {
    return null
  }

  // listed tokens trade only in their known pools, never in look-alike pools at odd prices
  const tiers: [number, number][] = listed ? listed.tiers : TIERS
  const routes = await discoverRoutes(a, tiers, !listed)
  if (!routes.length) return null
  const token = { address: a, symbol, name: listed?.name ?? name, decimals: Number(decimals), route: routes[0].route, routes: routes.map((r) => r.route), image: listed?.image, stock: listed?.stock }
  tokenCache.set(a, token)
  return token
}

export type Best = { route: PoolKey[]; out: bigint; next: bigint | null; checked: number }

/**
 * The route that pays the most for this exact amount, checked across every
 * route the token has. `next` is what the second-best route would have paid,
 * which is how the receipt shows what choosing well was worth.
 */
export async function bestRoute(t: Token, side: 'buy' | 'sell', amountIn: bigint): Promise<Best | null> {
  const assetIn = side === 'buy' ? ETH : t.address
  const candidates = t.routes.map((r) => (side === 'buy' ? r : [...r].reverse()))
  const outs = await Promise.all(candidates.map((route) => quote(assetIn, amountIn, route).then((out) => ({ route, out }))))
  const ok = outs.filter((o): o is { route: PoolKey[]; out: bigint } => o.out !== null).sort((a, b) => (a.out > b.out ? -1 : 1))
  if (!ok.length) return null
  return { route: ok[0].route, out: ok[0].out, next: ok[1]?.out ?? null, checked: candidates.length }
}

export const listedTokens = () => Promise.all(LISTED.filter((t) => !t.stock).map((t) => findToken(t.address))).then((l) => l.filter(Boolean) as Token[])

// ──────────────────────────────────────────────────────────────── token check

export type Verdict = 'normal' | 'careful' | 'skip'
export type Finding = { ok: boolean; label: string; detail: string }
export type Check = { verdict: Verdict; findings: Finding[]; at: number }

// Function selectors that give an owner power over holders.
const POWERS: [string, string][] = [
  ['40c10f19', 'can create more tokens'], // mint(address,uint256)
  ['a0712d68', 'can create more tokens'], // mint(uint256)
  ['8456cb59', 'can pause trading'], // pause()
  ['f9f92be4', 'can block wallets'], // blacklist(address)
  ['44337ea1', 'can block wallets'], // addToBlacklist / blacklistAddress
  ['e4997dc5', 'can block wallets'], // blockAddress(address) variants
  ['69fe0e2d', 'can change the trading fee'], // setFee(uint256)
  ['8ee88c53', 'can change the trading fee'], // setTaxFeePercent
]

const checkCache = new Map<string, Check>()

/**
 * Looks at a token the way a careful trader would, using only the chain:
 * can it be sold and moved, how deep is its pool, and what can its owner do.
 * Results are hints, not guarantees, and the app says so.
 */
// Results are kept on this phone for 10 minutes, so a token you just looked at
// opens with its answer already there, then quietly re-checks in the background.
const CHECK_TTL = 10 * 60_000
function storedCheck(address: string): Check | null {
  try {
    const v = JSON.parse(localStorage.getItem(`furtive.check.${address.toLowerCase()}`) || 'null') as Check | null
    return v && Date.now() - v.at < CHECK_TTL ? v : null
  } catch {
    return null
  }
}

/** The last answer for this token if there is a recent one, without waiting. */
export const recentCheck = (t: Token): Check | null => checkCache.get(t.address) ?? storedCheck(t.address)

export async function checkToken(t: Token, { fresh = false } = {}): Promise<Check> {
  const cached = checkCache.get(t.address)
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached
  const findings: Finding[] = []
  let worst: Verdict = 'normal'
  const flag = (v: Verdict) => (worst = v === 'skip' || worst === 'skip' ? 'skip' : v === 'careful' || worst === 'careful' ? 'careful' : 'normal')

  // Everything that does not depend on anything else goes at once, in one round trip.
  const small = 10n ** 14n // 0.0001 ETH
  const big = 10n ** 16n // 0.01 ETH
  const [bought, bigOut, moves, code, owner] = await Promise.all([
    quote(ETH, small, t.route),
    quote(ETH, big, t.route),
    client
      .simulateContract({ address: t.address, abi: ERC20, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1n], account: POOL_MANAGER })
      .then(() => true)
      .catch(() => false),
    client.getCode({ address: t.address }).catch(() => undefined),
    client.readContract({ address: t.address, abi: ERC20, functionName: 'owner' }).catch(() => null) as Promise<Address | null>,
  ])
  // Only this step waits: selling back what the small buy would get.
  const back = bought ? await quote(t.address, bought, [...t.route].reverse()) : null

  // 1. Can it be sold back?
  if (!bought || !back) {
    findings.push({ ok: false, label: 'Cannot be sold back', detail: 'A test sale did not go through.' })
    flag('skip')
  } else {
    const loss = Number(((small - back) * 10_000n) / small) / 100
    const ok = loss <= 8
    findings.push({ ok, label: ok ? 'Sells back normally' : 'Expensive to sell', detail: `Buying and selling right away would cost about ${loss.toFixed(1)}%.` })
    if (!ok) flag(loss > 30 ? 'skip' : 'careful')
  }

  // 2. Can it be moved at all? Honeypots often block transfers out of the pool.
  if (moves) findings.push({ ok: true, label: 'Moves freely', detail: 'Test transfers are not blocked.' })
  else {
    findings.push({ ok: false, label: 'Transfers are blocked', detail: 'The token refused a test transfer.' })
    flag('skip')
  }

  // 3. How deep is the pool? Compare a large buy with a small one.
  if (bought && bigOut) {
    const impact = 1 - Number(bigOut) / 100 / Number(bought)
    const pct = Math.max(0, impact * 100)
    const ok = pct <= 15
    findings.push({ ok, label: ok ? 'Healthy liquidity' : 'Thin liquidity', detail: `A 0.01 ETH buy would move the price about ${pct.toFixed(1)}%.` })
    if (!ok) flag('careful')
  }

  // 4. What can the owner do?
  if (code !== undefined) {
    const powers = [...new Set(POWERS.filter(([sel]) => (code ?? '0x').includes(sel)).map(([, p]) => p))]
    const renounced = !owner || /^0x0{40}$/i.test(owner) || owner.toLowerCase() === '0x000000000000000000000000000000000000dead'
    if (powers.length && !renounced) {
      findings.push({ ok: false, label: 'Owner keeps powers', detail: `The owner ${powers.join(', ')}.` })
      flag('careful')
    } else {
      findings.push({ ok: true, label: renounced && owner ? 'Ownership renounced' : 'No owner powers found', detail: 'Nobody can change the rules on holders.' })
    }
  }

  const result = { verdict: worst, findings, at: Date.now() }
  checkCache.set(t.address, result)
  try {
    localStorage.setItem(`furtive.check.${t.address.toLowerCase()}`, JSON.stringify(result))
  } catch {}
  return result
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  normal: 'Looks normal',
  careful: 'Be careful',
  skip: 'Skip this one',
}

/** Amounts for people: a token amount with up to `max` decimals. */
export function units(amount: bigint, decimals: number, max = 4) {
  const s = amount.toString().padStart(decimals + 1, '0')
  const i = s.slice(0, s.length - decimals) || '0'
  const d = s.slice(s.length - decimals).slice(0, max).replace(/0+$/, '')
  return `${Number(i).toLocaleString('en-US')}${d ? '.' + d : ''}`
}

export function parseUnitsSafe(text: string, decimals: number): bigint | null {
  const v = text.trim().replace(',', '.')
  if (!new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`).test(v) || v === '' || v === '.') return null
  const [i, d = ''] = v.split('.')
  const n = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((d + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return n > 0n ? n : null
}

// ─────────────────────────────────────────── mainnet tokens (read-only check)

const mainnet = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') })

/**
 * The same check, for a Robinhood Chain mainnet token seen in Discover: can it
 * move, what can its owner do, how deep is its pool. Trading tests run once
 * private trading is live on mainnet.
 */
export async function checkMainnet(address: string, liquidityUsd: number | null): Promise<Check> {
  const a = getAddress(address)
  const key = `main:${a}`
  const cached = checkCache.get(key)
  if (cached && Date.now() - cached.at < 120_000) return cached
  const findings: Finding[] = []
  let worst: Verdict = 'normal'
  const flag = (v: Verdict) => (worst = v === 'skip' || worst === 'skip' ? 'skip' : v === 'careful' || worst === 'careful' ? 'careful' : 'normal')

  try {
    await mainnet.simulateContract({ address: a, abi: ERC20, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1n], account: POOL_MANAGER })
    findings.push({ ok: true, label: 'Moves freely', detail: 'Test transfers out of the pool are not blocked.' })
  } catch {
    findings.push({ ok: false, label: 'Transfers are blocked', detail: 'The token refused a test transfer out of its pool.' })
    flag('skip')
  }

  const liq = liquidityUsd ?? 0
  if (liq < 10_000) {
    findings.push({ ok: false, label: 'Very thin liquidity', detail: `Only about $${Math.round(liq).toLocaleString('en-US')} in its pool. Small trades move the price a lot.` })
    flag(liq < 2_000 ? 'skip' : 'careful')
  } else {
    findings.push({ ok: true, label: 'Healthy liquidity', detail: `About $${Math.round(liq).toLocaleString('en-US')} in its pool.` })
  }

  try {
    const code = (await mainnet.getCode({ address: a })) ?? '0x'
    const powers = [...new Set(POWERS.filter(([sel]) => code.includes(sel)).map(([, p]) => p))]
    let owner: Address | null = null
    try {
      owner = await mainnet.readContract({ address: a, abi: ERC20, functionName: 'owner' })
    } catch {}
    const renounced = !owner || /^0x0{40}$/i.test(owner) || owner.toLowerCase() === '0x000000000000000000000000000000000000dead'
    if (powers.length && !renounced) {
      findings.push({ ok: false, label: 'Owner keeps powers', detail: `The owner ${powers.join(', ')}.` })
      flag('careful')
    } else {
      findings.push({ ok: true, label: renounced && owner ? 'Ownership renounced' : 'No owner powers found', detail: 'Nobody can change the rules on holders.' })
    }
  } catch {}

  const result = { verdict: worst, findings, at: Date.now() }
  checkCache.set(key, result)
  return result
}
