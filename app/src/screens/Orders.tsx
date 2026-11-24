import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Account } from '@sdk/wallet.mjs'
import { Button, Peeker, Spinner, ease, spring, cn } from '@/components/ui'
import { explorerTx } from '@/lib/config'
import { ethUsd, friendly, type Stage, type Wallet } from '@/lib/furtive'
import { findToken, parseUnitsSafe, units, type Token } from '@/lib/market'
import { EXPIRY, KIND, cancelOrder, isOpen, loadOrders, orderPool, placeOrder, planOrder, syncOrders, type OrderKind, type Plan, type SavedOrder } from '@/lib/orders'
import { notify, openLink, tap, inTelegram, backToChat, oneTap } from '@/lib/telegram'
import { LISTED } from '@/lib/config'
import { Avatar } from './Trade'

const STEPS: [Stage, string][] = [
  ['preparing', 'Getting ready'],
  ['proving', 'Making your proof on this phone'],
  ['sending', 'Placing your order'],
]

/** A token price in ETH, shown in dollars when the ETH price is known. */
function money(priceEth: number, usd: number | null) {
  if (usd) {
    const v = priceEth * usd
    return `$${v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(3)}`
  }
  return `${priceEth.toPrecision(4)} ETH`
}

// ──────────────────────────────────────────────────────────── place an order

export function OrderSheet({
  account,
  wallet,
  token,
  start,
  onLock,
  onDone,
}: {
  account: Account
  wallet: Wallet
  token: Token
  start?: { kind?: OrderKind; pct?: number; amount?: string; portion?: number; auto?: boolean }
  onLock: (b: boolean) => void
  onDone: () => void
}) {
  const tokBal = wallet.balance.get(BigInt(token.address)) ?? 0n
  const ethBal = wallet.balance.get(0n) ?? 0n
  const [kind, setKind] = useState<OrderKind>(start?.kind ?? (tokBal > 0n ? 'stop' : 'limit'))
  const k = KIND[kind]
  const [pct, setPct] = useState<number>(start?.pct && start.pct > 0 && start.pct < 100 ? start.pct : k.steps[1])
  // from the chat: a share of what is held ("All", "Half") becomes an exact amount
  const fromPortion = () => {
    const p = start?.portion
    const k0 = KIND[start?.kind ?? (tokBal > 0n ? 'stop' : 'limit')]
    const have0 = k0.side === 'buy' ? ethBal : tokBal
    if (!p || p <= 0 || p > 1 || have0 === 0n) return undefined
    const part = p === 1 ? have0 : (have0 * BigInt(Math.round(p * 1000))) / 1000n
    return units(part, k0.side === 'buy' ? 18 : token.decimals, 18).replace(/,/g, '')
  }
  const [text, setText] = useState(start?.amount ?? fromPortion() ?? '')
  const [exp, setExp] = useState(1)
  const [plan, setPlan] = useState<Plan | null | 'loading'>(null)
  const [usd, setUsd] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [placed, setPlaced] = useState<SavedOrder | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inDecimals = k.side === 'buy' ? 18 : token.decimals
  const inSymbol = k.side === 'buy' ? 'ETH' : token.symbol
  const outSymbol = k.side === 'buy' ? token.symbol : 'ETH'
  const outDecimals = k.side === 'buy' ? token.decimals : 18
  const have = k.side === 'buy' ? ethBal : tokBal
  const amount = parseUnitsSafe(text, inDecimals)
  const tooMuch = amount !== null && amount > have
  const canOrder = orderPool(token) !== null

  useEffect(() => void ethUsd().then(setUsd), [])

  // a new kind starts from its own middle step, and clears an amount typed in the other asset
  const first = useRef(true)
  useEffect(() => {
    if (first.current) return void (first.current = false)
    setPct(KIND[kind].steps[1])
    setText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  useEffect(() => {
    if (!amount || tooMuch) return setPlan(null)
    setPlan('loading')
    let live = true
    const id = setTimeout(() => planOrder(token, kind, pct, amount).then((p) => live && setPlan(p), () => live && setPlan(null)), 350)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [amount, tooMuch, kind, pct, token])

  const ready = amount !== null && !tooMuch && plan !== null && plan !== 'loading'
  // while new terms load, the last ones stay on screen, faded, instead of flashing
  const lastPlan = useRef<Plan | null>(null)
  if (plan && plan !== 'loading') lastPlan.current = plan
  if (!amount) lastPlan.current = null
  const shown = plan === 'loading' ? lastPlan.current : plan

  // One-tap from the chat: everything was chosen there, so place it as soon as the
  // terms are ready, then hand back to the chat.
  const autoRan = useRef(false)
  useEffect(() => {
    if (!start?.auto || !oneTap() || autoRan.current || !ready) return
    autoRan.current = true
    go()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  useEffect(() => {
    if (start?.auto && stage === 'done' && inTelegram()) {
      const id = setTimeout(backToChat, 2600)
      return () => clearTimeout(id)
    }
  }, [start?.auto, stage])

  const go = async () => {
    if (!ready || !amount || !plan) return
    setError(null)
    onLock(true)
    try {
      const o = await placeOrder(account, wallet.notes, { token, kind, amount, amountText: text, pct, plan, expiresIn: EXPIRY[exp][1] }, setStage)
      setPlaced(o)
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
        <motion.h2 key={stage} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease }} className="mt-6 text-[26px] leading-[1.08] tracking-[-0.035em]">
          {done ? (
            <>
              {k.label} set, <span className="serif">quietly.</span>
            </>
          ) : (
            STEPS[at]?.[1]
          )}
        </motion.h2>
        {!done && (
          <div className="mt-6 flex w-full max-w-[220px] gap-1.5">
            {STEPS.map(([s], i) => (
              <span key={s} className="h-1 flex-1 overflow-hidden rounded-full bg-ink/10">
                <motion.span className="block h-full rounded-full bg-ink" initial={{ width: 0 }} animate={{ width: i < at ? '100%' : i === at ? '60%' : 0 }} transition={{ duration: 0.8, ease }} />
              </span>
            ))}
          </div>
        )}
        {done && placed && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="mt-3 max-w-[300px] text-[14px] leading-relaxed text-muted">
            It fills by itself when {token.symbol} {k.up ? 'rises' : 'drops'} {pct}%. You can close Furtive. If it has not filled in {EXPIRY[exp][0]}, your {inSymbol} comes back on its own.
          </motion.p>
        )}
        {done && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35, duration: 0.35, ease }} className="w-full">
            <Button className="mt-8" onClick={onDone}>Done</Button>
          </motion.div>
        )}
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
        <Avatar symbol={token.symbol} size={40} image={token.image} stock={token.stock} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[18px] tracking-[-0.02em]">{token.symbol}</span>
          <span className="block truncate text-[13px] text-muted">{shown ? `Now ${money(shown.priceNow, usd)}` : token.name}</span>
        </span>
      </div>

      {/* Which order */}
      <div className="mt-6 flex rounded-full bg-paper-2 p-1 text-[13.5px] font-medium">
        {(Object.keys(KIND) as OrderKind[]).map((v) => {
          const off = KIND[v].side === 'sell' && tokBal === 0n
          return (
            <button key={v} type="button" disabled={off} onClick={() => (tap('light'), setKind(v))} className="relative z-10 flex-1 rounded-full py-2 disabled:opacity-35">
              {kind === v && <motion.span layoutId="order-kind" className="absolute inset-0 -z-10 rounded-full bg-ink" transition={spring} />}
              <span className={cn('transition-colors', kind === v ? 'text-paper' : 'text-ink')}>{KIND[v].label}</span>
            </button>
          )
        })}
      </div>

      {!canOrder ? (
        <p className="mt-8 text-center text-[14.5px] leading-relaxed text-muted">Orders need a direct ETH pool for {token.symbol}, and it has none yet. You can still trade it right away.</p>
      ) : (
        <>
          {/* How much */}
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
            {have > 0n && (
              <div className="mt-4 flex justify-center gap-2">
                {(k.side === 'buy'
                  ? ['0.01', '0.05', '0.1'].map((v) => [v, v] as const)
                  : ([['25%', 25n], ['50%', 50n], ['All', 100n]] as const).map(([l, pc]) => [l, units((have * pc) / 100n, inDecimals, inDecimals).replace(/,/g, '')] as const)
                ).map(([label, value]) => (
                  <Chip key={label} on={text === value} onClick={() => setText(value)}>
                    {label}
                  </Chip>
                ))}
              </div>
            )}
          </div>

          {/* When */}
          <div className="mt-7">
            <p className="text-[14px] text-muted">{k.verb} when {token.symbol} {k.up ? 'rises' : 'drops'}</p>
            <div className="mt-2.5 flex gap-2">
              {k.steps.map((s) => (
                <Chip key={s} on={pct === s} onClick={() => setPct(s)} wide>
                  {k.up ? '+' : '−'}
                  {s}%
                </Chip>
              ))}
            </div>
          </div>

          {/* For how long */}
          <div className="mt-5">
            <p className="text-[14px] text-muted">Keep it open for</p>
            <div className="mt-2.5 flex gap-2">
              {EXPIRY.map(([label], i) => (
                <Chip key={label} on={exp === i} onClick={() => setExp(i)} wide>
                  {label}
                </Chip>
              ))}
            </div>
          </div>

          {/* What happens */}
          <div className={cn('mt-6 rounded-[18px] bg-paper-2 px-4 py-3.5 transition-opacity', plan === 'loading' && shown && 'opacity-50')}>
            <Row label="Fills at" value={shown ? money(shown.triggerPrice, usd) : plan === 'loading' ? <Spinner className="size-3.5 border-[1.5px] text-muted" /> : '—'} />
            {shown && (
              <>
                <Row small label="You get about" value={`${units(shown.expected, outDecimals, 6)} ${outSymbol}`} />
                <Row small label="Guaranteed at least, or it waits" value={`${units(shown.minOut, outDecimals, 6)} ${outSymbol}`} />
              </>
            )}
          </div>

          {error && <p className="mt-3 text-[13.5px] text-danger">{error}</p>}
          <Button className="mt-5" disabled={!ready} onClick={go}>
            {`Place ${k.label.toLowerCase()} privately`}
          </Button>
          <p className="mt-2.5 text-center text-[12.5px] leading-relaxed text-muted-ink">Nobody can see whose order it is. Cancel any time before it fills.</p>
        </>
      )}
    </div>
  )
}

function Chip({ on, onClick, children, wide }: { on: boolean; onClick: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.92 }}
      onClick={() => (tap('light'), onClick())}
      className={cn('h-9 rounded-full px-3.5 text-[14px] font-medium tabular transition-colors', wide ? 'flex-1' : 'min-w-[64px]', on ? 'bg-ink text-paper' : 'bg-paper-2 text-ink')}
    >
      {children}
    </motion.button>
  )
}

function Row({ label, value, small }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between', small ? 'mt-1.5 text-[12.5px] text-muted-ink' : 'text-[14px]')}>
      <span className={small ? '' : 'text-muted'}>{label}</span>
      <span className={cn('tabular', !small && 'text-[16px]')}>{value}</span>
    </div>
  )
}

// ──────────────────────────────────────────────────────── pick what you hold

/** For a stop-loss or take profit from the chat: only the tokens this phone holds. */
export function HeldPicker({ wallet, kind, onPick }: { wallet: Wallet; kind: OrderKind; onPick: (t: Token) => void }) {
  const [held, setHeld] = useState<{ token: Token; amount: bigint }[] | null>(null)
  useEffect(() => {
    let live = true
    const entries = [...wallet.balance.entries()].filter(([a, v]) => a !== 0n && v > 0n)
    Promise.all(entries.map(async ([a, amount]) => ({ token: await findToken('0x' + a.toString(16).padStart(40, '0')), amount }))).then(
      (l) => live && setHeld(l.filter((x) => x.token) as { token: Token; amount: bigint }[]),
    )
    return () => {
      live = false
    }
  }, [wallet])
  return (
    <div className="pb-10">
      <h2 className="text-[24px] tracking-[-0.03em]">{KIND[kind].label}</h2>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Which of your tokens?</p>
      <div className="mt-4">
        {held === null && <div className="h-[60px] animate-pulse rounded-[18px] bg-ink/[0.05]" />}
        {held?.length === 0 && <p className="py-6 text-[14.5px] text-muted">You do not hold any tokens yet. Buy one first, then protect it with a stop-loss.</p>}
        {held?.map(({ token, amount }) => (
          <motion.button key={token.address} type="button" whileTap={{ scale: 0.98 }} onClick={() => (tap('light'), onPick(token))} className="flex w-full items-center gap-3 rounded-[18px] px-1 py-2.5 text-left">
            <Avatar symbol={token.symbol} image={token.image} stock={token.stock} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px]">{token.symbol}</span>
              <span className="block truncate text-[13px] text-muted">{token.name}</span>
            </span>
            <span className="text-[14px] text-muted tabular">{units(amount, token.decimals)}</span>
          </motion.button>
        ))}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────── your orders

/** An amount as people read it: 0.002349017289181609 shows as 0.00235. */
const short = (text: string) => {
  const n = Number(text)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 8 }) : text
}
/** The token's logo, also for orders saved before logos were kept with them. */
const logo = (t: SavedOrder['token']) => {
  const l = LISTED.find((x) => x.address.toLowerCase() === t.address.toLowerCase())
  return { image: t.image ?? l?.image, stock: t.stock ?? l?.stock }
}

const STATUS: Record<string, string> = {
  open: 'Waiting for its price',
  sending: 'Filling now',
  filled: 'Filled',
  returned: 'Expired, funds returned',
  cancelled: 'Cancelled, funds returned',
  closed: 'Closed',
}

export function OrdersList({ account, onRefresh }: { account: Account; onRefresh?: () => void }) {
  const [list, setList] = useState<SavedOrder[]>(() => loadOrders(account))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const run = () => syncOrders(account).then((l) => live && setList(l))
    run()
    const id = setInterval(run, 15_000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [account])

  const cancel = async (o: SavedOrder) => {
    setBusy(o.hash)
    setError(null)
    try {
      await cancelOrder(account, o)
      notify('success')
      setList(loadOrders(account))
      onRefresh?.()
    } catch (e) {
      notify('error')
      setError(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  const open = list.filter(isOpen)
  const done = list.filter((o) => !isOpen(o))

  return (
    <div className="pb-10">
      <h2 className="text-[24px] tracking-[-0.03em]">Orders</h2>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Limit buys, stop-losses and take profits. They fill by themselves, and nobody can see whose they are.</p>
      {error && <p className="mt-3 text-[13.5px] text-danger">{error}</p>}
      {list.length === 0 && (
        <div className="mt-14 flex flex-col items-center text-center">
          <div className="w-[72px]">
            <Peeker />
          </div>
          <p className="mt-5 text-[15px] text-muted">No orders yet. Open a token and tap Set an order.</p>
        </div>
      )}
      {open.length > 0 && <Group title="Open" items={open} busy={busy} onCancel={cancel} />}
      {done.length > 0 && <Group title="Done" items={done} busy={busy} />}
    </div>
  )
}

function Group({ title, items, busy, onCancel }: { title: string; items: SavedOrder[]; busy: string | null; onCancel?: (o: SavedOrder) => void }) {
  return (
    <section className="mt-7">
      <h3 className="text-[13px] text-muted">{title}</h3>
      <ul className="mt-2 divide-y divide-ink/[0.06]">
        {items.map((o) => {
          const k = KIND[o.kind]
          const inSymbol = k.side === 'buy' ? 'ETH' : o.token.symbol
          const expired = Date.now() / 1000 > o.expiry
          return (
            <li key={o.hash} className="flex items-center gap-3 py-3.5">
              <Avatar symbol={o.token.symbol} size={40} {...logo(o.token)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15.5px]">
                  {k.label} {o.token.symbol}
                </span>
                <span className="block truncate text-[12.5px] text-muted">
                  {short(o.amount)} {inSymbol} when {k.up ? '+' : '−'}
                  {o.pct}%
                </span>
                <span className="block truncate text-[12.5px] text-muted-ink">{expired && isOpen(o) ? 'Expired, returning your funds' : STATUS[o.status ?? 'open'] ?? 'Waiting for its price'}</span>
              </span>
              {onCancel && o.id && !expired && o.status !== 'sending' ? (
                <motion.button type="button" whileTap={{ scale: 0.92 }} disabled={busy !== null} onClick={() => (tap('light'), onCancel(o))} className="h-9 rounded-full bg-paper-2 px-3.5 text-[13.5px] font-medium disabled:opacity-40">
                  {busy === o.hash ? <Spinner className="size-3.5 border-[1.5px] text-muted" /> : 'Cancel'}
                </motion.button>
              ) : (
                <button type="button" onClick={() => (tap('light'), openLink(explorerTx(o.hash)))} className="text-[13px] text-muted underline underline-offset-4">
                  View
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

