// Robinhood Chain market data, through our relayer (which caches it).
import { RELAYER_URL } from './config'

export type MarketPool = {
  pool: string
  dex: string
  name: string
  token: { address: string; symbol: string; name: string; image: string | null }
  priceUsd: number | null
  change24h: number | null
  change1h: number | null
  volume24h: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  marketCapUsd: number | null
  createdAt: string | null
  txns24h: number | null
  /** Stock Tokens: the testnet token the app trades privately today */
  testnet?: string
}
export type Range = '1H' | '1D' | '1W' | '1M'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${RELAYER_URL}${path}`)
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return j
}

export const marketList = (list: 'trending' | 'new' | 'top') => get<{ pools: MarketPool[] }>(`/markets?list=${list}`).then((j) => j.pools)
export const marketStocks = () => get<{ pools: MarketPool[] }>('/markets/stocks').then((j) => j.pools)

export type Geo = { country: string; allowed: boolean; stocks: boolean }
let geoCache: Promise<Geo> | null = null
/** Where the network says this request comes from, for Stock Token rules. */
export const geo = () => (geoCache ??= get<Geo>('/geo').catch(() => ({ country: 'XX', allowed: true, stocks: true })))

export const marketSearch = (q: string) => get<{ pools: MarketPool[] }>(`/markets/search?q=${encodeURIComponent(q)}`).then((j) => j.pools)
// Chart ranges: [timeframe, aggregate, limit]
const RANGES: Record<Range, [string, number, number]> = { '1H': ['minute', 1, 60], '1D': ['minute', 15, 96], '1W': ['hour', 4, 42], '1M': ['day', 1, 30] }

/**
 * Price history for a pool. Fetched straight from GeckoTerminal (it limits shared
 * cloud servers, not phones): public market data only, nothing about the user.
 * Falls back to our relayer's simplified line if that is unavailable.
 */
export async function marketChart(pool: string, range: Range): Promise<{ points: [number, number][]; approx?: boolean }> {
  const [tf, agg, limit] = RANGES[range]
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=${limit}&currency=usd`, {
      headers: { accept: 'application/json' },
    })
    if (r.ok) {
      const list: number[][] = (await r.json())?.data?.attributes?.ohlcv_list ?? []
      if (list.length >= 2) return { points: list.map((c) => [c[0], c[4]] as [number, number]).reverse() }
    }
  } catch {}
  return get<{ points: [number, number][]; approx?: boolean }>(`/markets/chart?pool=${pool}&range=${range}`)
}

/** $1,234,567 -> $1.2M; prices keep significant digits for tiny memecoins. */
export function usd(n: number | null, compact = false) {
  if (n === null || !Number.isFinite(n)) return '—'
  if (compact) return '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  if (n >= 1) return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  if (n === 0) return '$0'
  return '$' + n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

export function pct(n: number | null) {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) < 10 ? 2 : 1)}%`
}
