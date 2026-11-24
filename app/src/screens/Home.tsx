import { useCallback, useRef, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import qrcode from 'qrcode-generator'
import type { Account } from '@sdk/wallet.mjs'
import { Action, Button, Check, Icon, Peeker, Screen, Sheet, Spinner, Ticker, ease, spring, cn } from '@/components/ui'
import { GAS_RESERVE, explorerTx } from '@/lib/config'
import { addFunds, depositable, ethUsd, friendly, loadActivity, logActivity, sendOut, type Activity, type Stage, type Wallet } from '@/lib/furtive'
import { eth, parseAmount, short } from '@/lib/format'
import { notify, openLink, pasteText, tap, telegramBack } from '@/lib/telegram'
import { checkToken, findToken, units, type Check as TokenCheck, type Token } from '@/lib/market'
import { activityIcon, activityTitle } from './Tabs'
import { Avatar, TradeSheet } from './Trade'

const fmtEth = (n: number) => (n === 0 ? '0' : n.toLocaleString('en-US', { maximumFractionDigits: 6 }))
const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const toEth = (wei: bigint) => Number(wei) / 1e18

type SheetName = 'add' | 'send' | 'settings' | 'trade' | null

export function Home({
  account,
  phrase,
  wallet,
  loading,
  error,
  onRefresh,
  onSignOut,
  onSeeAll,
  onOrder,
}: {
  account: Account
  phrase: string
  wallet: Wallet | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onSignOut: () => void
  onSeeAll: () => void
  onOrder?: (t: Token) => void
}) {
  const [sheet, setSheet] = useState<SheetName>(null)
  const [price, setPrice] = useState<number | null>(null)
  const [activity, setActivity] = useState<Activity[]>(() => loadActivity(account))
  const [tradeStart, setTradeStart] = useState<{ token: Token; side: 'buy' | 'sell' } | undefined>()
  const [tradeLocked, setTradeLocked] = useState(false)
  const [holdings, setHoldings] = useState<{ token: Token; amount: bigint; check: TokenCheck | null }[]>([])

  // Every token held privately, with its details, re-checked on this phone each
  // time (the watcher). Nothing about what you hold is sent to any Furtive server.
  const heldKey = wallet ? [...wallet.balance.entries()].filter(([a]) => a !== 0n).map(([a, v]) => `${a}:${v}`).join(',') : ''
  useEffect(() => {
    if (!wallet) return
    let live = true
    const entries = [...wallet.balance.entries()].filter(([a, v]) => a !== 0n && v > 0n)
    type Held = { token: Token; amount: bigint; check: TokenCheck | null }
    // rows appear as soon as each token is known; its safety check fills in after,
    // keeping the last check meanwhile, so nothing pops in late or blinks
    Promise.all(
      entries.map(async ([a, amount]) => {
        const token = await findToken('0x' + a.toString(16).padStart(40, '0'))
        return token ? { token, amount, check: null } : null
      }),
    ).then((l) => {
      if (!live) return
      const rows = l.filter(Boolean) as Held[]
      setHoldings((prev) => rows.map((r) => ({ ...r, check: prev.find((p) => p.token.address === r.token.address)?.check ?? null })))
      Promise.all(rows.map((r) => checkToken(r.token).catch(() => null))).then((checks) => live && setHoldings(rows.map((r, i) => ({ ...r, check: checks[i] }))))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey])
  const warnings = holdings.filter((h) => h.check && h.check.verdict !== 'normal')
  const balance = wallet?.balance.get(0n) ?? 0n
  const waiting = wallet && wallet.depositBalance > GAS_RESERVE ? wallet.depositBalance - GAS_RESERVE : 0n
  const empty = wallet !== null && balance === 0n && waiting === 0n && activity.length === 0 && wallet.balance.size === 0

  useEffect(() => {
    ethUsd().then(setPrice)
    const id = setInterval(() => ethUsd().then(setPrice), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => telegramBack(sheet ? () => setSheet(null) : null), [sheet])

  const close = useCallback(() => {
    setSheet(null)
    setActivity(loadActivity(account))
    onRefresh()
  }, [account, onRefresh])

  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('furtive.hidden') === '1'
    } catch {
      return false
    }
  })
  const toggleHidden = () => {
    tap('medium')
    setHidden((h) => {
      try {
        localStorage.setItem('furtive.hidden', h ? '0' : '1')
      } catch {}
      return !h
    })
  }
  const mask = (s: string) => (hidden ? '••••' : s)

  const balanceText = fmtEth(toEth(balance))
  const size = balanceText.length > 9 ? 'text-[42px]' : balanceText.length > 7 ? 'text-[48px]' : 'text-[56px]'

  return (
    <Screen>
      {/* The stage: balance on ink, the Peeker rising from its bottom edge. */}
      <section className="relative mx-2 mt-2 overflow-hidden rounded-[34px] bg-ink px-5 pt-4 pb-0 text-paper">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[140%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(243,239,231,.14),transparent)]" />
        <header className="relative flex h-10 items-center justify-between">
          <span className="text-[17px] font-medium tracking-[-0.03em]">furtive</span>
          <span className="flex items-center gap-1.5 text-[12px] text-muted-ink">
            <motion.span className="size-1.5 rounded-full bg-[#5DBB83]" animate={{ opacity: loading ? [1, 0.3, 1] : 1 }} transition={{ duration: 1, repeat: loading ? Infinity : 0 }} />
            Testnet
          </span>
        </header>

        <button type="button" onClick={toggleHidden} className="relative mt-7 block w-full text-left" aria-label={hidden ? 'Show balance' : 'Hide balance'}>
          <span className="flex items-center gap-2 text-[13.5px] text-muted-ink">
            Private balance
            <span className="rounded-full border border-paper/15 px-2 py-0.5 text-[11px]">{hidden ? 'Tap to show' : 'Tap to hide'}</span>
          </span>
          <span className="mt-2 flex h-[58px] items-baseline gap-2">
            {wallet ? (
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={hidden ? 'h' : 'v'} initial={{ opacity: 0, filter: 'blur(8px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, filter: 'blur(8px)' }} transition={{ duration: 0.3 }} className="flex items-baseline gap-2">
                  <span className={cn(size, 'leading-none font-medium tracking-[-0.05em]')}>{hidden ? '••••••' : <Ticker value={toEth(balance)} format={fmtEth} />}</span>
                  <span className="text-[18px] text-muted-ink">ETH</span>
                </motion.span>
              </AnimatePresence>
            ) : (
              <span className="mt-2 h-[44px] w-[170px] animate-pulse rounded-2xl bg-paper/10" />
            )}
          </span>
          <span className="mt-1.5 block h-5 text-[15px] text-muted-ink tabular">{wallet && price !== null ? mask(`≈ ${fmtUsd(toEth(balance) * price)}`) : ''}</span>
        </button>

        <div className="relative mt-6 flex items-end justify-between">
          <div className="flex gap-5 pb-6">
            {[
              ['Add', Icon.plus, () => setSheet('add'), false],
              ['Trade', Icon.trade, () => (setTradeStart(undefined), setSheet('trade')), !wallet],
              ['Send', Icon.send, () => setSheet('send'), !wallet || balance === 0n],
            ].map(([label, icon, go, off]) => (
              <motion.button
                key={label as string}
                type="button"
                disabled={off as boolean}
                whileTap={{ scale: 0.9 }}
                transition={spring}
                onClick={() => (tap('light'), (go as () => void)())}
                className="flex flex-col items-center gap-1.5 disabled:opacity-30"
              >
                <span className="grid size-[54px] place-items-center rounded-full bg-paper text-ink">{icon as ReactNode}</span>
                <span className="text-[12.5px] font-medium">{label as string}</span>
              </motion.button>
            ))}
          </div>
          <motion.div initial={{ y: 60 }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 140, damping: 16, delay: 0.2 }} className="-mr-1 w-[118px] text-paper">
            <Peeker eye="var(--color-ink)" mood={hidden ? 'closed' : loading && !wallet ? 'busy' : undefined} />
          </motion.div>
        </div>
      </section>

      {/* Below the stage: open, no boxes. */}
      <div className="flex-1 px-5 pt-7 pb-32">
        {empty ? (
          <GetStarted onAdd={() => setSheet('add')} />
        ) : (
          <>
            {warnings.map((w) => (
              <motion.button
                key={w.token.address}
                type="button"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => (tap('light'), setTradeStart({ token: w.token, side: 'sell' }), setSheet('trade'))}
                className="mb-6 flex w-full items-start gap-3 border-l-2 border-[#C98A2B] pl-3 text-left"
              >
                <span className="flex-1">
                  <span className="block text-[15px] font-medium">Heads up on {w.token.symbol}</span>
                  <span className="mt-0.5 block text-[13.5px] leading-snug text-muted">{w.check?.findings.filter((f) => !f.ok).map((f) => f.label).join(', ')}. Tap to review or sell.</span>
                </span>
              </motion.button>
            ))}

            {waiting > 0n && (
              <motion.button type="button" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} whileTap={{ scale: 0.98 }} onClick={() => (tap('light'), setSheet('add'))} className="mb-6 flex w-full items-center gap-3 text-left">
                <motion.span className="size-2.5 rounded-full bg-ink" animate={{ opacity: [1, 0.25, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
                <span className="flex-1">
                  <span className="block text-[15px]">{mask(eth(waiting))} ETH arrived</span>
                  <span className="block text-[13px] text-muted">Tap to move it into your private balance</span>
                </span>
                {Icon.chevron}
              </motion.button>
            )}

            <h2 className="px-1 text-[13px] text-muted">Holdings</h2>
            <ul className="mt-1.5 space-y-0.5">
              <li>
                <Row
                  icon={<span className="grid size-10 place-items-center rounded-full bg-paper-2">{Icon.eth}</span>}
                  title="Ether"
                  sub="Private"
                  right={
                    <span className="text-right">
                      <span className="block text-[16px] tabular">{mask(eth(balance))}</span>
                      {price !== null && <span className="block text-[12.5px] text-muted tabular">{mask(fmtUsd(toEth(balance) * price))}</span>}
                    </span>
                  }
                />
              </li>
              {holdings.map((h) => (
                <li key={h.token.address}>
                  <motion.button type="button" whileTap={{ scale: 0.98 }} onClick={() => (tap('light'), setTradeStart({ token: h.token, side: 'sell' }), setSheet('trade'))} className="w-full text-left">
                    <Row icon={<Avatar symbol={h.token.symbol} size={40} image={h.token.image} stock={h.token.stock} />} title={h.token.symbol} sub={h.token.name} right={<span className="text-[16px] tabular">{mask(units(h.amount, h.token.decimals))}</span>} />
                  </motion.button>
                </li>
              ))}
            </ul>

            <div className="mt-8 flex items-center justify-between">
              <h2 className="px-1 text-[13px] text-muted">Recent</h2>
              {activity.length > 3 && (
                <button type="button" onClick={() => (tap('light'), onSeeAll())} className="text-[13.5px] font-medium">
                  See all
                </button>
              )}
            </div>
            {activity.length === 0 ? (
              <p className="mt-3 text-[14px] text-muted-ink">What you do on this phone shows up here.</p>
            ) : (
              <ul className="mt-1.5 space-y-0.5">
                {activity.slice(0, 3).map((a, i) => (
                  <motion.li key={a.hash} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.4, ease }}>
                    <button type="button" onClick={() => openLink(explorerTx(a.hash))} className="w-full text-left">
                      <Row
                        icon={<span className="grid size-10 place-items-center rounded-[13px] bg-paper-2">{activityIcon(a)}</span>}
                        title={activityTitle(a)}
                        sub={when(a.at)}
                        right={<span className="text-[15px] tabular">{a.kind === 'add' || a.incoming ? '+' : '−'}{mask(a.amount)} {a.symbol ?? 'ETH'}</span>}
                      />
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && <p className="mt-5 text-[13.5px] text-muted">{friendly(error)}</p>}
      </div>

      <Sheet open={sheet === 'trade'} onClose={close} locked={tradeLocked}>
        {wallet && <TradeSheet key={tradeStart?.token.address ?? 'pick'} account={account} wallet={wallet} start={tradeStart} onLock={setTradeLocked} onDone={close} onRefresh={onRefresh} onOrder={onOrder && ((t) => (close(), onOrder(t)))} />}
      </Sheet>
      <Sheet open={sheet === 'add'} onClose={close}>
        {wallet && <AddSheet account={account} wallet={wallet} onDone={close} />}
      </Sheet>
      <SendSheetHost open={sheet === 'send'} account={account} wallet={wallet} price={price} onClose={close} />
    </Screen>
  )
}

function Row({ icon, title, sub, right }: { icon: ReactNode; title: string; sub: string; right: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 rounded-[18px] px-1 py-2.5">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15.5px]">{title}</span>
        <span className="block text-[13px] text-muted">{sub}</span>
      </span>
      {right}
    </div>
  )
}

function when(at: number) {
  const s = (Date.now() - at) / 1000
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function GetStarted({ onAdd }: { onAdd: () => void }) {
  const steps = [
    ['Get free test ETH', 'From the Robinhood Chain faucet, sent to your deposit address.'],
    ['Move it in', 'It joins the shared pool, where nobody on the chain can tell it is yours.'],
    ['Trade or send privately', 'Buy any token on Robinhood Chain, and nobody on the chain can tell it was you.'],
  ]
  return (
    <div>
      <h2 className="text-[20px] tracking-[-0.02em]">Get started</h2>
      <ol className="mt-5 space-y-5">
        {steps.map(([t, d], i) => (
          <motion.li key={t} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.08, duration: 0.5, ease }} className="grid grid-cols-[28px_1fr] gap-3">
            <span className="grid size-7 place-items-center rounded-full bg-ink text-[13px] font-medium text-paper tabular">{i + 1}</span>
            <span>
              <span className="block text-[15.5px]">{t}</span>
              <span className="mt-0.5 block text-[14px] leading-relaxed text-muted">{d}</span>
            </span>
          </motion.li>
        ))}
      </ol>
      <Button className="mt-7" onClick={onAdd}>Add funds</Button>
    </div>
  )
}

function Qr({ text }: { text: string }) {
  const { d, n } = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(text)
    q.make()
    const n = q.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { d, n }
  }, [text])
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} className="block size-full" shapeRendering="crispEdges" role="img" aria-label="Deposit address QR code">
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="var(--color-card)" />
      <path d={d} fill="var(--color-ink)" />
    </svg>
  )
}

export function AddSheet({ account, wallet, onDone }: { account: Account; wallet: Wallet; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const [amount, setAmount] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [moved, setMoved] = useState<{ amount: bigint; fee: bigint } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const arrived = wallet.depositBalance > GAS_RESERVE ? wallet.depositBalance - GAS_RESERVE : 0n

  useEffect(() => {
    depositable(wallet.depositBalance).then(setAmount).catch(() => setAmount(0n))
  }, [wallet.depositBalance])

  // The moment a deposit arrives, move it in. Nothing to tap.
  const auto = useRef(false)
  useEffect(() => {
    if (amount && amount > 0n && !auto.current) {
      auto.current = true
      move()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.depositAddress)
    } catch {}
    tap('medium')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const move = async () => {
    if (!amount) return
    setBusy(true)
    setError(null)
    try {
      const hash = await addFunds(account, amount)
      setMoved({ amount, fee: wallet.depositBalance > amount ? wallet.depositBalance - amount : 0n })
      logActivity(account, { kind: 'add', amount: eth(amount), hash, at: Date.now() })
      notify('success')
      setDone(true)
      setTimeout(onDone, 3200)
    } catch (e) {
      notify('error')
      setError(friendly(e))
      setBusy(false)
    }
  }

  if (done) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center py-12 text-center">
        <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }} className="w-[100px]">
          <Peeker mood="happy" />
        </motion.div>
        <p className="mt-5 text-[22px] tracking-[-0.03em]">
          In the pool, <span className="serif">out of sight.</span>
        </p>
        {moved && (
          <p className="mt-2 text-[14px] text-muted">
            {eth(moved.amount)} ETH is now private.{moved.fee > 0n && <> The network took {eth(moved.fee)} ETH to move it in.</>}
          </p>
        )}
      </motion.div>
    )
  }

  return (
    <div className="pb-2">
      <h2 className="text-[24px] tracking-[-0.03em]">Add funds</h2>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Send ETH on Robinhood Chain to this address from any wallet or exchange. It moves into your private balance by itself, minus a tiny network fee for the move.</p>
      <button type="button" onClick={() => (tap('light'), openLink('https://faucet.testnet.chain.robinhood.com'))} className="mt-3 text-[14px] font-medium text-ink underline decoration-ink/30 underline-offset-4">
        Need test ETH? Get it free from the Robinhood Chain faucet
      </button>

      <div className="mt-6 flex items-center gap-4">
        <div className="size-[104px] shrink-0 overflow-hidden rounded-[14px]">
          <Qr text={wallet.depositAddress} />
        </div>
        <div className="min-w-0 flex-1 pr-1">
          <span className="text-[12.5px] text-muted">Your deposit address</span>
          <span className="mt-1 block font-mono text-[13px] leading-snug break-all">{wallet.depositAddress}</span>
          <motion.button type="button" whileTap={{ scale: 0.94 }} onClick={copy} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-paper-2 px-3 py-1.5 text-[13px] font-medium">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={copied ? 'y' : 'n'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} className="inline-flex items-center gap-1.5">
                {copied ? 'Copied' : <>{Icon.copy} Copy</>}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-[16px] bg-paper-2 px-4 py-3.5">
        <span className="flex items-center gap-2 text-[14px] text-muted">
          {arrived === 0n && <Spinner className="size-3 border-[1.5px]" />}
          {arrived === 0n ? 'Watching for your deposit' : busy ? 'Arrived, moving it into the pool' : 'Arrived'}
        </span>
        {arrived > 0n && <span className="text-[15px] tabular">{eth(arrived)} ETH</span>}
      </div>
      {error && <p className="mt-3 text-[13.5px] text-danger">{error}</p>}

      {error && amount ? (
        <Button className="mt-5" disabled={busy} onClick={move}>
          {busy ? <Spinner /> : 'Try again'}
        </Button>
      ) : null}
    </div>
  )
}

function SendSheetHost({ open, account, wallet, price, onClose }: { open: boolean; account: Account; wallet: Wallet | null; price: number | null; onClose: () => void }) {
  const [locked, setLocked] = useState(false)
  return (
    <Sheet open={open} onClose={onClose} locked={locked}>
      {wallet && <SendSheet account={account} wallet={wallet} price={price} onLock={setLocked} onDone={onClose} />}
    </Sheet>
  )
}

const STEPS: [Stage, string][] = [
  ['preparing', 'Getting ready'],
  ['proving', 'Making your proof on this phone'],
  ['sending', 'Sending it through the pool'],
]

function SendSheet({ account, wallet, price, onLock, onDone }: { account: Account; wallet: Wallet; price: number | null; onLock: (b: boolean) => void; onDone: () => void }) {
  const balance = wallet.balance.get(0n) ?? 0n
  const [amountText, setAmountText] = useState('')
  const [to, setTo] = useState('')
  const [stage, setStage] = useState<Stage | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const amount = parseAmount(amountText)
  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to.trim())
  const tooMuch = amount !== null && amount > balance
  const ready = amount !== null && !tooMuch && validTo

  const send = async () => {
    if (!amount) return
    setError(null)
    onLock(true)
    try {
      const h = await sendOut(account, wallet.notes, amount, to.trim(), setStage)
      setHash(h)
      logActivity(account, { kind: 'send', amount: eth(amount), to: to.trim(), hash: h, at: Date.now() })
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
                {eth(amount ?? 0n)} ETH sent, <span className="serif">quietly.</span>
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
            To {short(to)}.{' '}
            <button type="button" className="text-ink underline underline-offset-4" onClick={() => openLink(explorerTx(hash))}>
              View it
            </button>
          </motion.p>
        )}
        {done && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35, duration: 0.35, ease }} className="w-full">
            <Button className="mt-8" onClick={onDone}>Done</Button>
          </motion.div>
        )}
      </div>
    )
  }

  return (
    <div className="pb-2">
      <h2 className="text-[24px] tracking-[-0.03em]">Send privately</h2>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">It leaves from the shared pool, so nobody on the chain can tell it came from you.</p>

      <div className="mt-6 text-center">
        <div className="flex items-baseline justify-center gap-2">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            style={{ width: `${Math.max(1, amountText.length) * 0.6 + 0.3}em` }}
            className={cn('max-w-[78%] bg-transparent text-center text-[48px] leading-none font-medium tracking-[-0.05em] tabular outline-none placeholder:text-muted-ink', tooMuch && 'text-danger')}
          />
          <span className="text-[20px] text-muted">ETH</span>
        </div>
        <p className="mt-2 h-5 text-[14px] text-muted tabular">{amount !== null && price !== null ? `≈ ${fmtUsd(toEth(amount) * price)}` : ''}</p>
        <div className="mt-2 flex items-center justify-center gap-2 text-[13.5px] text-muted">
          <span className={cn(tooMuch && 'text-danger')}>{tooMuch ? 'More than you have' : `${eth(balance)} ETH available`}</span>
          <motion.button whileTap={{ scale: 0.92 }} type="button" onClick={() => (tap('light'), setAmountText(eth(balance).replace(/,/g, '')))} className="rounded-full bg-paper-2 px-2.5 py-1 text-[12.5px] font-medium text-ink">
            Max
          </motion.button>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 rounded-[16px] bg-paper-2 px-4 py-3 transition-shadow focus-within:shadow-[0_0_0_1.5px_var(--color-ink)]">
        <label className="min-w-0 flex-1">
          <span className="text-[12.5px] text-muted">To</span>
          <input
            placeholder="0x…"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-0.5 block w-full bg-transparent font-mono text-[14.5px] outline-none placeholder:text-muted-ink"
          />
        </label>
        <motion.button
          type="button"
          whileTap={{ scale: 0.92 }}
          onClick={async () => {
            tap('light')
            const t = (await pasteText()).trim()
            if (t) setTo(t)
          }}
          className="shrink-0 rounded-full bg-paper-2 px-3 py-1.5 text-[13px] font-medium"
        >
          Paste
        </motion.button>
      </div>
      <p className={cn('mt-2 text-[12.5px]', to && !validTo ? 'text-danger' : 'text-muted-ink')}>{to && !validTo ? 'That is not a Robinhood Chain address.' : 'A fresh wallet keeps it the most private.'}</p>
      {error && <p className="mt-3 text-[13.5px] text-danger">{error}</p>}

      <Button className="mt-5" disabled={!ready} onClick={send}>
        Send privately
      </Button>
    </div>
  )
}

function SettingsSheet({ phrase, onSignOut }: { phrase: string; onSignOut: () => void }) {
  const [view, setView] = useState<'menu' | 'phrase' | 'signout'>('menu')
  const [shown, setShown] = useState(false)
  const words = phrase.split(' ')
  const items: [string, string, () => void][] = [
    ['Recovery phrase', 'View your 12 words', () => setView('phrase')],
    ['Sign out of this phone', 'You will need your 12 words to come back', () => setView('signout')],
  ]

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === 'menu' && (
        <motion.div key="menu" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={spring} className="pb-2">
          <h2 className="text-[24px] tracking-[-0.03em]">Settings</h2>
          <div className="mt-5 overflow-hidden rounded-[22px] bg-card shadow-[0_0_0_1px_rgba(22,23,27,.06)]">
            {items.map(([t, d, go], i) => (
              <motion.button key={t} type="button" whileTap={{ scale: 0.99 }} onClick={() => (tap('light'), go())} className={cn('flex w-full items-center gap-3 px-4 py-4 text-left', i > 0 && 'border-t border-ink/[0.06]')}>
                <span className="flex-1">
                  <span className="block text-[15.5px]">{t}</span>
                  <span className="block text-[13px] text-muted">{d}</span>
                </span>
                {Icon.chevron}
              </motion.button>
            ))}
          </div>
          <p className="mt-5 text-center text-[12.5px] text-muted-ink">Furtive on Robinhood Chain testnet</p>
        </motion.div>
      )}

      {view === 'phrase' && (
        <motion.div key="phrase" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={spring} className="pb-2">
          <h2 className="text-[24px] tracking-[-0.03em]">Recovery phrase</h2>
          <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Make sure nobody can see your screen.</p>
          <div className="relative mt-5">
            <ol className="grid grid-cols-3 gap-2">
              {words.map((w, i) => (
                <motion.li key={i} animate={{ filter: shown ? 'blur(0px)' : 'blur(7px)' }} transition={{ delay: shown ? i * 0.03 : 0 }} className="flex items-baseline gap-1.5 rounded-2xl bg-card px-3 py-3 text-[15px] shadow-[0_0_0_1px_rgba(22,23,27,.05)]">
                  <span className="w-4 text-[11px] text-muted-ink tabular">{i + 1}</span>
                  {w}
                </motion.li>
              ))}
            </ol>
            {!shown && (
              <button type="button" onClick={() => (tap('medium'), setShown(true))} className="absolute inset-0 grid place-items-center">
                <span className="rounded-full bg-ink px-5 py-3 text-[15px] font-medium text-paper">Tap to reveal</span>
              </button>
            )}
          </div>
          <Button variant="soft" className="mt-5" onClick={() => (setShown(false), setView('menu'))}>Done</Button>
        </motion.div>
      )}

      {view === 'signout' && (
        <motion.div key="signout" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={spring} className="pb-2">
          <h2 className="text-[24px] tracking-[-0.03em]">Sign out of this phone?</h2>
          <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">Your money stays safe in the pool. To get back in you will need your 12 words. Without them nobody can recover it, not even us.</p>
          <div className="mt-6 space-y-2">
            <Button className="bg-danger" onClick={onSignOut}>Sign out</Button>
            <Button variant="soft" onClick={() => setView('menu')}>Keep me signed in</Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
