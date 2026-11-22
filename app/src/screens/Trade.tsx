import { AddSheet } from '@/screens/Home'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Account } from '@sdk/wallet.mjs'
import { Button, Check, Peeker, Spinner, ease, spring, cn } from '@/components/ui'
import { ETH, explorerTx } from '@/lib/config'
import { friendly, logActivity, trade, type Stage, type Wallet, sendReceipt } from '@/lib/furtive'
import { bestRoute, checkToken, recentCheck, findToken, listedTokens, parseUnitsSafe, units, VERDICT_TEXT, type Best, type Check as TokenCheck, type Token } from '@/lib/market'
import { notify, openLink, pasteText, tap, inTelegram, backToChat, oneTap, initData } from '@/lib/telegram'
import { STOCK_LOGOS } from '@/lib/logos'
import { StockLogo } from './Discover'

const SLIPPAGE_BPS = 200n // 2%

export function TradeSheet({
  account,
  wallet,
  start,
  onLock,
  onDone,
  onRefresh,
}: {
  account: Account
  wallet: Wallet
  start?: { token: Token; side: 'buy' | 'sell'; amount?: string; auto?: boolean; expect?: string }
  onLock: (b: boolean) => void
  onDone: () => void
  onRefresh?: () => void
}) {
  const [token, setToken] = useState<Token | null>(start?.token ?? null)
  const [side, setSide] = useState<'buy' | 'sell'>(start?.side ?? 'buy')
  // No ETH yet: add it right here, then come straight back to this trade.
  const [adding, setAdding] = useState(false)
  return (
    <AnimatePresence mode="wait" initial={false}>
      {adding ? (
        <motion.div key="add" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={spring}>
          <AddSheet account={account} wallet={wallet} onDone={() => (setAdding(false), onRefresh?.())} />
        </motion.div>
      ) : token ? (
        <motion.div key="trade" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={spring}>
          <Ticket account={account} wallet={wallet} token={token} side={side} setSide={setSide} initialAmount={start?.amount} auto={start?.auto} expect={start?.expect} onBack={start ? undefined : () => setToken(null)} onLock={onLock} onDone={onDone} onAddFunds={() => (tap('light'), setAdding(true))} />
        </motion.div>
      ) : (
        <motion.div key="pick" initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={spring}>
          <Picker wallet={wallet} onPick={(t) => (tap('light'), setToken(t))} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─────────────────────────────────────────────────────────────── pick a token

function Picker({ wallet, onPick }: { wallet: Wallet; onPick: (t: Token) => void }) {
  const [listed, setListed] = useState<Token[] | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Token | null | 'none' | 'loading'>(null)

  useEffect(() => {
    listedTokens().then(setListed)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(q)) return setFound(null)
    setFound('loading')
    let live = true
    findToken(q).then((t) => live && setFound(t ?? 'none'))
    return () => {
      live = false
    }
  }, [query])

  const shown = (listed ?? []).filter((t) => !query || `${t.symbol} ${t.name}`.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="pb-2">
      <h2 className="text-[24px] tracking-[-0.03em]">Trade</h2>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Pick a token, or paste any address on Robinhood Chain.</p>

      <div className="mt-5 flex items-center gap-2 rounded-[16px] bg-paper-2 px-4 py-3 transition-shadow focus-within:shadow-[0_0_0_1.5px_var(--color-ink)]">
        <svg viewBox="0 0 24 24" className="size-[18px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or 0x address"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[15.5px] outline-none placeholder:text-muted-ink"
        />
        <motion.button type="button" whileTap={{ scale: 0.92 }} onClick={async () => setQuery((await pasteText()).trim())} className="shrink-0 rounded-full bg-paper-2 px-3 py-1.5 text-[13px] font-medium">
          Paste
        </motion.button>
      </div>

      <div className="mt-4 min-h-[180px]">
        {found === 'loading' && (
          <p className="flex items-center gap-2 py-4 text-[14px] text-muted">
            <Spinner className="size-3.5 border-[1.5px]" /> Looking it up
          </p>
        )}
        {found === 'none' && <p className="py-4 text-[14px] text-muted">No ETH pool trades this token yet.</p>}
        {found && typeof found === 'object' && <TokenRow t={found} wallet={wallet} onPick={onPick} />}
        {!found && listed === null && (
          <div className="space-y-2 pt-1">
            {[0, 1].map((i) => (
              <div key={i} className="h-[60px] animate-pulse rounded-[18px] bg-ink/[0.05]" />
            ))}
          </div>
        )}
        {!found && listed && shown.map((t) => <TokenRow key={t.address} t={t} wallet={wallet} onPick={onPick} />)}
      </div>
    </div>
  )
}

function TokenRow({ t, wallet, onPick }: { t: Token; wallet: Wallet; onPick: (t: Token) => void }) {
  const held = wallet.balance.get(BigInt(t.address)) ?? 0n
  return (
    <motion.button type="button" whileTap={{ scale: 0.98 }} onClick={() => onPick(t)} className="flex w-full items-center gap-3 rounded-[18px] px-1 py-2.5 text-left">
      <Avatar symbol={t.symbol} image={t.image} stock={t.stock} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px]">{t.symbol}</span>
        <span className="block truncate text-[13px] text-muted">{t.name}</span>
      </span>
      {held > 0n && <span className="text-[14px] text-muted tabular">{units(held, t.decimals)}</span>}
    </motion.button>
  )
}

export function Avatar({ symbol, size = 44, image, stock }: { symbol: string; size?: number; image?: string; stock?: boolean }) {
  if (stock && STOCK_LOGOS[symbol]) return <StockLogo symbol={symbol} size={size} />
  if (image) return <img src={image} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-full bg-paper-2 object-cover" />
  return (
    <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-full bg-ink text-[13px] font-medium tracking-[-0.02em] text-paper">
      {symbol.slice(0, 4)}
    </span>
  )
}

// ──────────────────────────────────────────────────────────────── the ticket

const STEPS: [Stage, string][] = [
  ['preparing', 'Getting ready'],
  ['proving', 'Making your proof on this phone'],
  ['sending', 'Trading through the pool'],
]

function Ticket({
  account,
  wallet,
  token,
  side,
  setSide,
  initialAmount,
  onBack,
  onLock,
  onDone,
  onAddFunds,
  auto,
  expect,
}: {
  account: Account
  wallet: Wallet
  onAddFunds: () => void
  auto?: boolean
  expect?: string
  token: Token
  side: 'buy' | 'sell'
  setSide: (s: 'buy' | 'sell') => void
  initialAmount?: string
  onBack?: () => void
  onLock: (b: boolean) => void
  onDone: () => void
}) {
  const ethBal = wallet.balance.get(0n) ?? 0n
  const tokBal = wallet.balance.get(BigInt(token.address)) ?? 0n
  const inDecimals = side === 'buy' ? 18 : token.decimals
  const inSymbol = side === 'buy' ? 'ETH' : token.symbol
  const outSymbol = side === 'buy' ? token.symbol : 'ETH'
  const outDecimals = side === 'buy' ? token.decimals : 18
  const have = side === 'buy' ? ethBal : tokBal

  const [text, setText] = useState(initialAmount ?? '')
  const firstSide = useRef(true)
  const [best, setBest] = useState<Best | null | 'loading'>(null)
  const [check, setCheck] = useState<TokenCheck | null>(() => recentCheck(token))
  const [stage, setStage] = useState<Stage | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const amount = parseUnitsSafe(text, inDecimals)
  const tooMuch = amount !== null && amount > have

  useEffect(() => {
    checkToken(token).then(setCheck)
  }, [token])

  // Live quote, a moment after typing stops.
  useEffect(() => {
    // switching buy and sell clears the amount, but not on first open (a chat order fills it)
    if (firstSide.current) return void (firstSide.current = false)
    setText('')
    setBest(null)
  }, [side])
  useEffect(() => {
    if (!amount) return setBest(null)
    setBest('loading')
    let live = true
    const id = setTimeout(() => {
      // every route is priced for this exact amount, after the vault's 0.3% fee
      bestRoute(token, side, amount - (amount * 30n) / 10_000n).then((b) => live && setBest(b))
    }, 350)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [amount, side, token])

  const out = best && best !== 'loading' ? best.out : best === 'loading' ? 'loading' : null
  const minOut = typeof out === 'bigint' ? (out * (10_000n - SLIPPAGE_BPS)) / 10_000n : null
  const ready = amount !== null && !tooMuch && typeof out === 'bigint' && check !== null && check.verdict !== 'skip'

  // One-tap: confirmed in the chat already, so trade as soon as everything checks out,
  // but only if the token looks normal and the price has not moved against you.
  const autoRan = useRef(false)
  const [autoDone, setAutoDone] = useState(false)
  useEffect(() => {
    // a one-tap trade only goes on a check made in the last minute
    if (!auto || !oneTap() || autoRan.current || !ready || check?.verdict !== 'normal' || Date.now() - check.at > 60_000 || typeof out !== 'bigint') return
    if (expect) {
      const want = parseUnitsSafe(expect, outDecimals)
      if (want && out < (want * 98n) / 100n) return
    }
    autoRan.current = true
    setAutoDone(true)
    go()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, ready, check, out])
  // ...and then hand you back to the chat.
  useEffect(() => {
    if (autoDone && stage === 'done' && inTelegram()) {
      const id = setTimeout(backToChat, 2200)
      return () => clearTimeout(id)
    }
  }, [autoDone, stage])

  const go = async () => {
    if (!amount || !minOut || !best || best === 'loading') return
    setError(null)
    onLock(true)
    try {
      const h = await trade(
        account,
        wallet.notes,
        { assetIn: side === 'buy' ? ETH : token.address, amountIn: amount, assetOut: side === 'buy' ? token.address : ETH, minOut, route: best.route },
        setStage,
      )
      setHash(h)
      // started in the chat: the result goes back there too
      if (auto) sendReceipt(initData(), { side, symbol: token.symbol, address: token.address, spent: units(amount, inDecimals, 6), spentSymbol: inSymbol, got: units(best.out, outDecimals, 6), gotSymbol: outSymbol })
      logActivity(account, {
        kind: side,
        amount: units(amount, inDecimals, 6),
        symbol: side === 'buy' ? 'ETH' : token.symbol,
        hash: h,
        at: Date.now(),
        got: units(best.out, outDecimals, 6),
        next: best.next !== null ? units(best.next, outDecimals, 6) : undefined,
        gain: best.next !== null && best.out > best.next ? units(best.out - best.next, outDecimals, 6) : undefined,
        outSymbol,
        routes: best.checked,
      })
      notify('success')
    } catch (e) {
      notify('error')
      setStage(null)
      setError(friendly(e))
    } finally {
      onLock(false)
    }
  }

  if (stage) {
    const at = STEPS.findIndex(([s]) => s === stage)
    const done = stage === 'done'
    return (
      <div className="flex flex-col items-center pt-4 pb-2 text-center">
        <AnimatePresence mode="wait">
          {done ? (
            <motion.div key="ok" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }} className="w-[110px]">
              <Peeker mood="happy" />
            </motion.div>
          ) : (
            <motion.div key="busy" className="w-[96px]" animate={{ y: [0, -5, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}>
              <Peeker busy={stage === 'proving'} />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence mode="wait">
          <motion.h2 key={stage} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease }} className="mt-6 text-[26px] leading-[1.08] tracking-[-0.035em]">
            {done ? (
              <>
                {side === 'buy' ? 'Bought' : 'Sold'} {token.symbol}, <span className="serif">quietly.</span>
              </>
            ) : (
              STEPS[at]?.[1]
            )}
          </motion.h2>
        </AnimatePresence>
        {!done && (
          <div className="mt-6 flex w-full max-w-[220px] gap-1.5">
            {STEPS.map(([s], i) => (
              <span key={s} className="h-1 flex-1 overflow-hidden rounded-full bg-ink/10">
                <motion.span className="block h-full rounded-full bg-ink" initial={{ width: 0 }} animate={{ width: i < at ? '100%' : i === at ? '60%' : 0 }} transition={{ duration: 0.8, ease }} />
              </span>
            ))}
          </div>
        )}
        {done && hash && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="mt-3 text-[14px] text-muted">
            Nobody on the chain can tell it was you.{' '}
            <button type="button" className="text-ink underline underline-offset-4" onClick={() => openLink(explorerTx(hash))}>
              View it
            </button>
          </motion.p>
        )}
        {done && <Button className="mt-8" onClick={onDone}>Done</Button>}
        {done && inTelegram() && (
          <button type="button" onClick={() => (tap('light'), backToChat())} className="mt-3 py-2 text-[14.5px] font-medium text-muted">
            Back to chat
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="pb-2">
      <div className="flex items-center gap-3">
        {onBack && (
          <motion.button type="button" whileTap={{ scale: 0.85 }} onClick={() => (tap('light'), onBack())} aria-label="Back" className="-ml-2 grid size-10 place-items-center rounded-full">
            <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </motion.button>
        )}
        <Avatar symbol={token.symbol} size={40} image={token.image} stock={token.stock} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] tracking-[-0.02em]">{token.symbol}</span>
          <span className="block truncate text-[13px] text-muted">{token.name}</span>
        </span>
        <Segmented value={side} onChange={(v) => (tap('light'), setSide(v))} canSell={tokBal > 0n} />
      </div>

      <div className="mt-7 text-center">
        <div className="flex items-baseline justify-center gap-2">
          <input
            inputMode="decimal"
            placeholder="0"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: `${Math.max(1, text.length) * 0.6 + 0.3}em` }}
            className={cn('max-w-[72%] bg-transparent text-center text-[48px] leading-none font-medium tracking-[-0.05em] tabular outline-none placeholder:text-muted-ink', tooMuch && have > 0n && 'text-danger')}
          />
          <span className="text-[20px] text-muted">{inSymbol}</span>
        </div>
        <p className={cn('mt-3 text-[13.5px] text-muted', tooMuch && have > 0n && 'text-danger')}>
          {have === 0n ? `No ${inSymbol} yet` : tooMuch ? 'More than you have' : `${units(have, inDecimals, 6)} ${inSymbol} available`}
        </p>
        {/* Quick sizes: no typing */}
        {(side === 'buy' || have > 0n) && (
          <div className="mt-4 flex justify-center gap-2">
            {(side === 'buy'
              ? ['0.01', '0.05', '0.1'].map((v) => [`${v}`, v] as const)
              : ([['25%', 25n], ['50%', 50n], ['All', 100n]] as const).map(([l, pc]) => [l, units((have * pc) / 100n, inDecimals, inDecimals).replace(/,/g, '')] as const)
            ).map(([label, value]) => (
              <motion.button
                key={label}
                type="button"
                whileTap={{ scale: 0.92 }}
                onClick={() => (tap('light'), setText(value))}
                className={cn('h-9 min-w-[64px] rounded-full px-3.5 text-[14px] font-medium tabular transition-colors', text === value ? 'bg-ink text-paper' : 'bg-paper-2 text-ink')}
              >
                {label}
              </motion.button>
            ))}
          </div>
        )}
      </div>

      {/* What you get */}
      <div className="mt-6 rounded-[18px] bg-paper-2 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[14px] text-muted">You get about</span>
          <span className="text-[16px] tabular">
            {out === 'loading' ? <Spinner className="size-3.5 border-[1.5px] text-muted" /> : typeof out === 'bigint' ? `${units(out, outDecimals, 6)} ${outSymbol}` : amount ? 'No price' : '—'}
          </span>
        </div>
        {typeof out === 'bigint' && minOut !== null && (
          <div className="mt-1.5 flex items-center justify-between text-[12.5px] text-muted-ink">
            <span>Guaranteed at least, or it cancels</span>
            <span className="tabular">{units(minOut, outDecimals, 6)} {outSymbol}</span>
          </div>
        )}
        {best && best !== 'loading' && best.checked > 1 && (
          <div className="mt-1.5 flex items-center justify-between text-[12.5px] text-muted-ink">
            <span>Best of {best.checked} routes</span>
            <span className="tabular">{best.next !== null && best.out > best.next ? `+${units(best.out - best.next, outDecimals, 6)} ${outSymbol} vs the next` : 'Tied with the next'}</span>
          </div>
        )}
      </div>

      {side === 'buy' && <CheckCard check={check} />}
      {error && <p className="mt-3 text-[13.5px] text-danger">{error}</p>}

      {side === 'buy' && tooMuch ? (
        <Button className="mt-5" onClick={onAddFunds}>
          {have === 0n ? 'Add ETH to buy' : 'Add more ETH'}
        </Button>
      ) : (
      <Button className="mt-5" disabled={!ready} onClick={go}>
        {check?.verdict === 'skip' && side === 'buy' ? 'Blocked for your safety' : side === 'buy' ? `Buy ${token.symbol} privately` : `Sell ${token.symbol} privately`}
      </Button>
      )}
      <p className="mt-2.5 text-center text-[12.5px] text-muted-ink">0.3% Furtive fee is included in the price.</p>
    </div>
  )
}

function Segmented({ value, onChange, canSell }: { value: 'buy' | 'sell'; onChange: (v: 'buy' | 'sell') => void; canSell: boolean }) {
  return (
    <div className="relative flex rounded-full bg-paper-2 p-1 text-[13.5px] font-medium">
      {(['buy', 'sell'] as const).map((v) => (
        <button key={v} type="button" disabled={v === 'sell' && !canSell} onClick={() => onChange(v)} className="relative z-10 rounded-full px-3.5 py-1.5 capitalize disabled:opacity-35">
          {value === v && <motion.span layoutId="seg" className="absolute inset-0 -z-10 rounded-full bg-ink" transition={spring} />}
          <span className={cn('transition-colors', value === v ? 'text-paper' : 'text-ink')}>{v}</span>
        </button>
      ))}
    </div>
  )
}

const TONE = { normal: 'bg-[#3F8F5E]', careful: 'bg-[#C98A2B]', skip: 'bg-danger' } as const
const TILE = { normal: 'bg-[#3F8F5E]/12', careful: 'bg-[#C98A2B]/14', skip: 'bg-danger/12' } as const

export function CheckCard({ check }: { check: TokenCheck | null }) {
  const [open, setOpen] = useState(false)
  const bad = useMemo(() => check?.findings.filter((f) => !f.ok) ?? [], [check])
  return (
    <motion.div layout transition={spring} className="mt-1 overflow-hidden">
      <button type="button" onClick={() => check && (tap('light'), setOpen(!open))} className="flex w-full items-center gap-3.5 rounded-[18px] px-1 py-2.5 text-left">
        <span className={cn('grid size-10 shrink-0 place-items-center rounded-[13px]', check ? TILE[check.verdict] : 'bg-paper-2')}>
          {check ? <span className={cn('size-2.5 rounded-full', TONE[check.verdict])} /> : <Spinner className="size-3 border-[1.5px] text-muted" />}
        </span>
        <span className="flex-1">
          <span className="block text-[15px]">{check ? VERDICT_TEXT[check.verdict] : 'Checking this token'}</span>
          <span className="block text-[12.5px] text-muted">
            {check ? (bad.length ? bad.map((b) => b.label).join(', ') : check.findings.map((f) => f.label).join(', ')) : 'Transfers, liquidity, owner powers'}
          </span>
        </span>
        {check && (
          <motion.svg animate={{ rotate: open ? 90 : 0 }} viewBox="0 0 24 24" className="size-5 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></motion.svg>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && check && (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease }} className="space-y-3 px-1 pt-1 pb-4">
            {check.findings.map((f) => (
              <li key={f.label} className="grid grid-cols-[18px_1fr] gap-2.5 text-[13.5px]">
                <span className={cn('mt-[3px] grid size-[15px] place-items-center rounded-full text-paper', f.ok ? 'bg-[#3F8F5E]' : 'bg-danger')}>
                  <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">{f.ok ? <path d="M5 12l5 5L20 7" /> : <path d="M6 6l12 12M18 6L6 18" />}</svg>
                </span>
                <span>
                  <span className="block">{f.label}</span>
                  <span className="block text-muted">{f.detail}</span>
                </span>
              </li>
            ))}
            <li className="text-[12px] leading-relaxed text-muted-ink">Checks read the chain right now. They are a guide, not a guarantee.</li>
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
