import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Button, Screen, TopBar, ease, cn } from '@/components/ui'
import { Chart } from '@/components/Chart'
import { geo, marketChart, pct, usd, type Geo, type MarketPool, type Range } from '@/lib/markets-api'
import { tap, openLink } from '@/lib/telegram'
import { TokenImage } from './Discover'
import { CheckCard } from './Trade'
import { checkMainnet, checkToken, findToken, type Check as TokenCheck, type Token } from '@/lib/market'

const RANGES: Range[] = ['1H', '1D', '1W', '1M']

/** A Robinhood Chain token: live price, chart, stats and what can be done with it. */
export function TokenPage({ pool, onBack, onTrade }: { pool: MarketPool; onBack: () => void; onTrade: (t: Token) => void }) {
  const [range, setRange] = useState<Range>('1D')
  const [points, setPoints] = useState<[number, number][] | null>(null)
  const [approx, setApprox] = useState(false)
  const [check, setCheck] = useState<TokenCheck | null>(null)
  // Stock Tokens trade privately today, on testnet, where the country allows it.
  const [tradable, setTradable] = useState<Token | null>(null)
  const [where, setWhere] = useState<Geo | null>(null)
  useEffect(() => {
    if (!pool.testnet) return
    geo().then(setWhere)
    // start the safety check now, so Trade opens with it done
    findToken(pool.testnet).then((t) => (setTradable(t), t && checkToken(t).catch(() => {})))
  }, [pool.testnet])
  useEffect(() => {
    checkMainnet(pool.token.address, pool.liquidityUsd).then(setCheck).catch(() => {})
  }, [pool.token.address, pool.liquidityUsd])
  const [scrub, setScrub] = useState<[number, number] | null>(null)

  // Show whatever arrives first; if it is the rough line, quietly try again for the
  // detailed one. Network hiccups retry on their own instead of showing nothing.
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    setPoints(null)
    setApprox(false)
    const load = (attempt: number) =>
      marketChart(pool.pool, range)
        .then((r) => {
          if (!live) return
          if (r.points.length >= 2) {
            setPoints(r.points)
            setApprox(!!r.approx)
          }
          if ((r.approx || r.points.length < 2) && attempt < 4) timer = setTimeout(() => load(attempt + 1), 6000 * (attempt + 1))
          else if (r.points.length < 2) setPoints((p) => p ?? [])
        })
        .catch(() => {
          if (!live) return
          if (attempt < 4) timer = setTimeout(() => load(attempt + 1), 4000 * (attempt + 1))
          else setPoints((p) => p ?? [])
        })
    load(0)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [pool.pool, range])

  const first = points?.[0]?.[1]
  const last = points?.at(-1)?.[1] ?? pool.priceUsd
  const shown = scrub ? scrub[1] : last
  const change = first && shown ? ((shown - first) / first) * 100 : range === '1D' ? pool.change24h : null
  const up = (change ?? 0) >= 0

  const stats: [string, string][] = [
    ['Liquidity', usd(pool.liquidityUsd, true)],
    ['24h volume', usd(pool.volume24h, true)],
    ['Market cap', usd(pool.marketCapUsd ?? pool.fdvUsd, true)],
    ['24h trades', pool.txns24h !== null ? pool.txns24h.toLocaleString('en-US') : '—'],
  ]

  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="px-5 pb-40">
        <div className="flex items-center gap-3">
          <TokenImage src={pool.token.image} symbol={pool.token.symbol} size={48} stock={!!pool.testnet} />
          <div className="min-w-0">
            <h1 className="truncate text-[22px] leading-tight tracking-[-0.03em]">{pool.token.name || pool.token.symbol}</h1>
            <p className="text-[13.5px] text-muted">{pool.token.symbol} on Robinhood Chain</p>
          </div>
        </div>

        <div className="mt-6">
          <p className="text-[40px] leading-none font-medium tracking-[-0.045em] tabular">{usd(shown ?? null)}</p>
          <p className={cn('mt-2 text-[14.5px] tabular', up ? 'text-[#3F8F5E]' : 'text-danger')}>
            {pct(change)} <span className="text-muted">{scrub ? new Date(scrub[0] * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : range === '1H' ? 'past hour' : range === '1D' ? 'today' : range === '1W' ? 'past week' : 'past month'}</span>
          </p>
        </div>

        <div className="-mx-5 mt-5">
          {points ? <Chart points={points} up={up} onScrub={setScrub} /> : <div className="mx-5 h-[180px] animate-pulse rounded-2xl bg-ink/[0.04]" />}
        </div>

        {approx && <p className="mt-1 text-right text-[11.5px] text-muted-ink">Simplified line while the full chart loads</p>}
        <div className="mt-3 flex gap-1 rounded-full bg-paper-2 p-1 text-[13px] font-medium">
          {RANGES.map((r) => (
            <button key={r} type="button" onClick={() => (tap('light'), setRange(r))} className={cn('flex-1 rounded-full py-1.5 transition-colors', range === r ? 'bg-card shadow-[0_1px_3px_rgba(22,23,27,.12)]' : 'text-muted')}>
              {r}
            </button>
          ))}
        </div>

        <motion.dl initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 px-1">
          {stats.map(([k, v]) => (
            <div key={k}>
              <dt className="text-[12.5px] text-muted">{k}</dt>
              <dd className="mt-1 text-[17px] tracking-[-0.01em] tabular">{v}</dd>
            </div>
          ))}
        </motion.dl>

        <h2 className="mt-8 px-1 text-[13px] text-muted">Safety check</h2>
        <CheckCard check={check} />

        <button type="button" onClick={() => openLink(`https://robin.etherscan.io/token/${pool.token.address}`)} className="mt-4 flex w-full items-center justify-between rounded-[18px] px-1 py-2 text-left text-[13.5px] text-muted">
          <span className="font-mono">{pool.token.address.slice(0, 10)}…{pool.token.address.slice(-6)}</span>
          <span className="text-ink underline underline-offset-4">View contract</span>
        </button>
      </div>

      <div className="safe-b fixed inset-x-0 bottom-0 mx-auto max-w-[460px] bg-gradient-to-t from-paper via-paper to-paper/0 px-5 pt-6">
        {pool.testnet ? (
          where && !where.stocks ? (
            <Button disabled>Stock Tokens are not available in your country</Button>
          ) : (
            <Button disabled={!tradable} onClick={() => tradable && onTrade(tradable)}>
              {tradable ? `Trade ${pool.token.symbol} privately` : 'Getting the test pool ready'}
            </Button>
          )
        ) : (
          <Button disabled>Private trading opens at mainnet launch</Button>
        )}
        {pool.testnet && <p className="mt-2 text-center text-[12px] text-muted-ink">Real price shown. Trades settle on testnet in Furtive's pool at that price.</p>}
      </div>
    </Screen>
  )
}
