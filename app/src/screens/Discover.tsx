import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Peeker, ease, spring, cn } from '@/components/ui'
import { marketList, marketSearch, marketStocks, pct, usd, type MarketPool } from '@/lib/markets-api'
import { listedTokens, type Token } from '@/lib/market'
import { STOCK_LOGOS } from '@/lib/logos'
import { tap } from '@/lib/telegram'

type List = 'trending' | 'top' | 'new' | 'stocks'
const LISTS: [List, string][] = [
  ['trending', 'Trending'],
  ['top', 'Top'],
  ['new', 'New'],
  ['stocks', 'Stocks'],
]

export function Discover({ onOpen, onOpenTest }: { onOpen: (p: MarketPool) => void; onOpenTest: (t: Token) => void }) {
  const [list, setList] = useState<List>('trending')
  const [data, setData] = useState<Record<List, MarketPool[] | null>>({ trending: null, top: null, new: null, stocks: null })
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketPool[] | null>(null)
  const [test, setTest] = useState<Token[]>([])

  useEffect(() => {
    listedTokens().then(setTest).catch(() => {})
  }, [])

  useEffect(() => {
    if (data[list]) return
    setError(false)
    ;(list === 'stocks' ? marketStocks() : marketList(list))
      .then((pools) => setData((d) => ({ ...d, [list]: pools })))
      .catch(() => setError(true))
  }, [list, data])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return setResults(null)
    let live = true
    const id = setTimeout(() => marketSearch(q).then((r) => live && setResults(r)).catch(() => live && setResults([])), 300)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [query])

  const rows = results ?? data[list]

  return (
    <div className="px-5 pb-28">
      <header className="relative flex items-end justify-between pt-5">
        <div>
          <h1 className="text-[30px] leading-none tracking-[-0.04em]">Discover</h1>
          <p className="mt-2 text-[14px] text-muted">Live from Robinhood Chain.</p>
        </div>
        <div className="-mb-[3px] w-[64px]">
          <Peeker />
        </div>
      </header>

      <div className="mt-5 flex items-center gap-2 rounded-[16px] bg-paper-2 px-4 py-3 transition-shadow focus-within:shadow-[0_0_0_1.5px_var(--color-ink)]">
        <svg viewBox="0 0 24 24" className="size-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tokens" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[15.5px] outline-none placeholder:text-muted-ink" />
        {query && (
          <button type="button" onClick={() => setQuery('')} className="text-[13px] font-medium text-muted">
            Clear
          </button>
        )}
      </div>

      {!results && test.length > 0 && (
        <button type="button" onClick={() => (tap('light'), onOpenTest(test[0]))} className="mt-3 block px-1 text-left text-[13.5px] text-muted">
          New here? Practice a private trade with <span className="font-medium text-ink underline underline-offset-4">{test[0].symbol}</span>, a test token.
        </button>
      )}

      {!results && (
        <div className="relative mt-6 flex gap-1 rounded-full bg-paper-2 p-1 text-[13.5px] font-medium">
          {LISTS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => (tap('light'), setList(id))} className="relative z-10 flex-1 rounded-full py-2">
              {list === id && <motion.span layoutId="discover-tab" className="absolute inset-0 -z-10 rounded-full bg-card shadow-[0_1px_3px_rgba(22,23,27,.12)]" transition={spring} />}
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        {error && !rows && <p className="py-8 text-center text-[14px] text-muted">Market data is taking a moment. Pull down or switch lists to try again.</p>}
        {!results && list === 'stocks' && <p className="px-1 pt-1 pb-2 text-[12.5px] text-muted-ink">Real prices from Robinhood Chain. Trade them privately on testnet now.</p>}
        {!rows && !error && (
          <div className="space-y-1">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3">
                <span className="size-11 animate-pulse rounded-full bg-ink/[0.06]" />
                <span className="h-4 flex-1 animate-pulse rounded bg-ink/[0.06]" />
                <span className="h-4 w-16 animate-pulse rounded bg-ink/[0.06]" />
              </div>
            ))}
          </div>
        )}
        <AnimatePresence mode="wait">
          {rows && (
            <motion.ul key={results ? 'search' : list} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-0.5">
              {rows.length === 0 && <li className="py-8 text-center text-[14px] text-muted">Nothing found on Robinhood Chain.</li>}
              {rows.map((p, i) => (
                <motion.li key={p.pool} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.03, duration: 0.4, ease }}>
                  <PoolRow p={p} onOpen={onOpen} stock={!results && list === 'stocks'} rank={!results && (list === 'trending' || list === 'top') ? i + 1 : undefined} />
                </motion.li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** A company logo on its brand colour, for Stock Tokens. */
export function StockLogo({ symbol, size = 44 }: { symbol: string; size?: number }) {
  const l = STOCK_LOGOS[symbol]
  if (!l) return null
  return (
    <span style={{ width: size, height: size, background: l.hex }} className="grid shrink-0 place-items-center rounded-full">
      <svg viewBox="0 0 24 24" style={{ width: size * 0.52, height: size * 0.52 }} fill="#fff" aria-hidden="true">
        <path d={l.path} />
      </svg>
    </span>
  )
}

export function TokenImage({ src, symbol, size = 44, stock = false }: { src: string | null; symbol: string; size?: number; stock?: boolean }) {
  const [broken, setBroken] = useState(false)
  if (stock && STOCK_LOGOS[symbol]) return <StockLogo symbol={symbol} size={size} />
  if (!src || broken)
    return (
      <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-full bg-ink text-[12px] font-medium text-paper">
        {symbol.slice(0, 4)}
      </span>
    )
  return <img src={src} alt="" onError={() => setBroken(true)} style={{ width: size, height: size }} className="shrink-0 rounded-full bg-paper-2 object-cover" />
}

function PoolRow({ p, onOpen, rank, stock = false }: { p: MarketPool; onOpen: (p: MarketPool) => void; rank?: number; stock?: boolean }) {
  const up = (p.change24h ?? 0) >= 0
  return (
    <motion.button type="button" whileTap={{ scale: 0.98 }} onClick={() => (tap('light'), onOpen(p))} className="flex w-full items-center gap-3.5 rounded-[18px] px-1 py-2.5 text-left active:bg-paper-2/60">
      {rank !== undefined && <span className="w-4 text-[12px] text-muted-ink tabular">{rank}</span>}
      <TokenImage src={p.token.image} symbol={p.token.symbol} stock={stock} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px]">{p.token.symbol}</span>
        <span className="block truncate text-[12.5px] text-muted">{stock ? p.token.name : `${usd(p.liquidityUsd, true)} liquidity`}</span>
      </span>
      <span className="text-right">
        <span className="block text-[15.5px] tabular">{usd(p.priceUsd)}</span>
        <span className={cn('block text-[12.5px] tabular', up ? 'text-[#3F8F5E]' : 'text-danger')}>{pct(p.change24h)}</span>
      </span>
    </motion.button>
  )
}
