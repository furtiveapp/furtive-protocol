import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Account as Acct } from '@sdk/wallet.mjs'
import { Button, Icon, Peeker, Screen, TopBar, spring, cn } from '@/components/ui'
import { explorerTx } from '@/lib/config'
import { loadActivity, setAlerts, type Activity } from '@/lib/furtive'
import { short } from '@/lib/format'
import { initData, openLink, tap, oneTap, setOneTap } from '@/lib/telegram'

// ───────────────────────────────────────────────────────────────── tab bar

export type Tab = 'home' | 'discover' | 'activity' | 'account'

// Furtive's own tab glyphs, all drawn from the Peeker's dome.
const DOME = 'M4 20V13.5C4 8.8 7.6 5 12 5s8 3.8 8 8.5V20Z'
const TABS: [Tab, string, ReactNode][] = [
  // Home: the dome itself
  ['home', 'Home', <svg key="h" viewBox="0 0 24 24" className="size-[23px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d={DOME} /><path d="M10 20v-3.5a2 2 0 0 1 4 0V20" /></svg>],
  // Discover: the Peeker's own half-lidded eye, looking
  ['discover', 'Discover', <svg key="d" viewBox="0 0 24 24" className="size-[23px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 9.5h18c0 7.5-18 7.5-18 0Z" /><circle cx="14.2" cy="11.6" r="2.4" fill="currentColor" stroke="none" /></svg>],
  // Activity: three domes rising, like bars
  ['activity', 'Activity', <svg key="a" viewBox="0 0 24 24" className="size-[23px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3.5 20v-3a2.25 2.25 0 0 1 4.5 0v3ZM9.75 20v-7a2.25 2.25 0 0 1 4.5 0v7ZM16 20V8a2.25 2.25 0 0 1 4.5 0v12Z" /></svg>],
  // Account: the Peeker, two eyes
  ['account', 'Account', <svg key="u" viewBox="0 0 24 24" className="size-[23px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d={DOME} /><path d="M7.4 12h3.6c0 2.2-3.6 2.2-3.6 0ZM13 12h3.6c0 2.2-3.6 2.2-3.6 0Z" fill="currentColor" /></svg>],
]

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="safe-b fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[460px] border-t border-ink/[0.07] bg-paper/85 backdrop-blur-xl">
      <div className="flex px-2 pt-1.5">
        {TABS.map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => (tap('light'), onTab(id))} className="relative flex flex-1 flex-col items-center gap-0.5 rounded-[20px] py-2">
            <motion.span animate={{ y: tab === id ? -1 : 0, scale: tab === id ? 1.06 : 1 }} transition={spring} className={cn('relative transition-colors duration-200', tab === id ? 'text-ink' : 'text-muted-ink')}>{icon}</motion.span>
            <span className={cn('relative text-[11px] font-medium transition-colors duration-200', tab === id ? 'text-ink' : 'text-muted-ink')}>{label}</span>
            {tab === id && <motion.span layoutId="tab-dot" className="absolute -bottom-0.5 size-1 rounded-full bg-ink" transition={spring} />}
          </button>
        ))}
      </div>
    </nav>
  )
}

// ──────────────────────────────────────────────────────────────── activity

const FILTERS: [string, Activity['kind'][]][] = [
  ['All', ['add', 'send', 'buy', 'sell']],
  ['Trades', ['buy', 'sell']],
  ['Sends', ['send']],
  ['Deposits', ['add']],
]

export const activityTitle = (a: Activity) => (a.kind === 'add' ? 'Added to your balance' : a.kind === 'send' ? `Sent to ${short(a.to ?? '')}` : a.kind === 'buy' ? 'Bought privately' : 'Sold privately')
export const activityIcon = (a: Activity) => (a.kind === 'add' ? Icon.plus : a.kind === 'send' ? Icon.send : Icon.trade)

export function ActivityTab({ account, onOpen }: { account: Acct; onOpen: (a: Activity) => void }) {
  const [filter, setFilter] = useState(0)
  const all = loadActivity(account)
  const list = all.filter((a) => FILTERS[filter][1].includes(a.kind))

  const groups = new Map<string, Activity[]>()
  for (const a of list) {
    const d = new Date(a.at)
    const key = new Date().toDateString() === d.toDateString() ? 'Today' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    groups.set(key, [...(groups.get(key) ?? []), a])
  }

  return (
    <div className="px-5 pb-28">
      <header className="pt-5">
        <h1 className="text-[30px] leading-none tracking-[-0.04em]">Activity</h1>
        <p className="mt-2 text-[14px] text-muted">Kept on this phone only. The chain cannot tie any of it to you.</p>
      </header>
      <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map(([label], i) => (
          <button key={label} type="button" onClick={() => (tap('light'), setFilter(i))} className={cn('shrink-0 rounded-full px-4 py-2 text-[13.5px] font-medium transition-colors', filter === i ? 'bg-ink text-paper' : 'bg-paper-2 text-ink')}>
            {label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center pt-20 text-center">
          <div className="w-[96px]">
            <Peeker />
          </div>
          <p className="mt-6 text-[20px] tracking-[-0.02em]">
            Nothing here <span className="serif">yet.</span>
          </p>
          <p className="mt-2 max-w-[260px] text-[14px] text-muted">Your trades, sends and deposits will show up here.</p>
        </div>
      ) : (
        [...groups.entries()].map(([day, items]) => (
          <section key={day} className="mt-7">
            <h2 className="px-1 text-[13px] text-muted">{day}</h2>
            <ul className="mt-1.5 space-y-0.5">
              {items.map((a) => (
                <li key={a.hash}>
                  <motion.button type="button" whileTap={{ scale: 0.985 }} onClick={() => (tap('light'), onOpen(a))} className="flex w-full items-center gap-3.5 rounded-[18px] px-1 py-2.5 text-left active:bg-paper-2/60">
                    <span className="grid size-10 place-items-center rounded-[13px] bg-paper-2">{activityIcon(a)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15.5px]">{activityTitle(a)}</span>
                      <span className="block text-[12.5px] text-muted">{new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                    </span>
                    <span className="text-[15px] tabular">
                      {a.kind === 'add' ? '+' : '−'}
                      {a.amount} {a.symbol ?? 'ETH'}
                    </span>
                  </motion.button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

export function Receipt({ a, onBack }: { a: Activity; onBack: () => void }) {
  const rows: [string, string][] = [
    ['What', activityTitle(a)],
    ['Amount', `${a.amount} ${a.symbol ?? 'ETH'}`],
    ['When', new Date(a.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })],
    ...(a.got ? ([['You got', `${a.got} ${a.outSymbol ?? ''}`]] as [string, string][]) : []),
    ...(a.got && a.routes
      ? ([[
          'Best price',
          a.routes > 1 ? (a.gain ? `${a.gain} ${a.outSymbol ?? ''} more than the next-best of ${a.routes} routes` : `Tied with the next-best of ${a.routes} routes`) : 'Only one pool traded it, so this was the best available',
        ]] as [string, string][])
      : []),
    ['Sent by', a.kind === 'add' ? 'Your deposit wallet' : 'The Furtive relayer, not your wallet'],
    ['Linked to you on chain', a.kind === 'add' ? 'Only the deposit itself' : 'No'],
  ]
  return (
    <Screen>
      <TopBar onBack={onBack} title="Receipt" />
      <div className="px-5 pb-10">
        <div className="flex flex-col items-center pt-6 pb-8 text-center">
          <span className="w-[78px] text-ink">
            <Peeker mood="happy" />
          </span>
          <p className="mt-5 text-[34px] leading-none font-medium tracking-[-0.04em] tabular">
            {a.kind === 'add' ? '+' : '−'}
            {a.amount} <span className="text-[18px] font-normal text-muted">{a.symbol ?? 'ETH'}</span>
          </p>
          <p className="mt-2 text-[14.5px] text-muted">{activityTitle(a)}</p>
        </div>
        <dl className="space-y-1">
          {rows.map(([k, v], i) => (
            <div key={k} className="flex items-start justify-between gap-4 rounded-[16px] px-1 py-2.5">
              <dt className="text-[14px] text-muted">{k}</dt>
              <dd className="text-right text-[14.5px]">{v}</dd>
            </div>
          ))}
        </dl>
        <Button variant="soft" className="mt-5" onClick={() => openLink(explorerTx(a.hash))}>View on the explorer</Button>
      </div>
    </Screen>
  )
}

// ───────────────────────────────────────────────────────────────── account

export function AccountTab({ address, holdings, onPrivacy, onPhrase, onSignOut }: { address: string; holdings: { address: string; symbol: string }[]; onPrivacy: () => void; onPhrase: () => void; onSignOut: () => void }) {
  const [alerts, setAlertsOn] = useState(() => {
    try {
      return localStorage.getItem('furtive.alerts') === '1'
    } catch {
      return false
    }
  })
  const [alertNote, setAlertNote] = useState<string | null>(null)
  const toggleAlerts = async () => {
    tap('medium')
    const next = !alerts
    setAlertNote(null)
    try {
      await setAlerts(next, holdings, initData())
      setAlertsOn(next)
      try {
        localStorage.setItem('furtive.alerts', next ? '1' : '0')
      } catch {}
      setAlertNote(next ? (holdings.length ? `Watching ${holdings.map((h) => h.symbol).join(', ')}.` : 'On. Tokens you buy will be watched.') : null)
    } catch (e) {
      setAlertNote(e instanceof Error ? e.message : 'Could not change alerts right now.')
    }
  }
  const [copied, setCopied] = useState(false)
  const [fast, setFast] = useState(oneTap)
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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
    } catch {}
    tap('medium')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="px-5 pb-32">
      {/* Identity */}
      <section className="flex flex-col items-center pt-8 text-center">
        <div className="w-[112px]">
          <Peeker mood={hidden ? 'closed' : undefined} />
        </div>
        <h1 className="mt-5 text-[26px] leading-tight tracking-[-0.035em]">
          Your private <span className="serif">account</span>
        </h1>
        <motion.button type="button" whileTap={{ scale: 0.96 }} onClick={copy} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-paper-2 px-3 py-1.5 font-mono text-[12.5px]">
          {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'}
          <span className="font-sans text-[12px] text-muted">{copied ? 'Copied' : Icon.copy}</span>
        </motion.button>
        <p className="mt-3 flex items-center gap-3 text-[12.5px] text-muted">
          <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#3F8F5E]" />Keys on this phone</span>
          <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#3F8F5E]" />Nobody else holds it</span>
        </p>
      </section>

      {/* Security */}
      <Group title="Security">
        <Item icon={IconKey} title="Recovery phrase" sub="Your 12 words, the key to everything" onClick={onPhrase} />
        <Item title="Rescue tool" sub="Take everything out with your 12 words, even without Furtive" onClick={() => openLink('https://app.furtive.app/rescue')} />
        <Item title="Open source" sub="The code that holds your money, and who it builds on" onClick={() => openLink('https://github.com/furtiveapp/furtive-protocol')} />
        <Item
          icon={IconEye}
          title="Hide balances"
          sub="Amounts show as dots until you tap"
          onClick={toggleHidden}
          right={<Switch on={hidden} />}
        />
      </Group>

      <Group title="Trading">
        <Item title="One-tap from the chat" sub="Confirm in the chat and the trade runs as Furtive opens" onClick={() => (setOneTap(!fast), setFast(!fast))} right={<Switch on={fast} />} />
      </Group>

      <Group title="Alerts">
        <Item icon={IconBell} title="Heads up in Telegram" sub="A message if a token you hold drops hard or cannot be sold" onClick={toggleAlerts} right={<Switch on={alerts} />} />
        <p className="px-1 pt-1 text-[12px] leading-relaxed text-muted-ink">{alertNote ?? 'Turning this on shares which tokens you hold with the Furtive bot, so it can watch them. Never your wallet or amounts.'}</p>
      </Group>

      <Group title="Privacy">
        <Item icon={IconShield} title="How your privacy works" sub="What Furtive hides, and what it cannot" onClick={onPrivacy} />
      </Group>

      <Group title="Network">
        <Item icon={IconChain} title="Robinhood Chain" sub="Testnet" right={<span className="flex items-center gap-1.5 text-[12.5px] text-muted"><span className="size-1.5 rounded-full bg-[#3F8F5E]" />Live</span>} />
      </Group>

      {/* Community */}
      <section className="mt-9 flex flex-col items-center">
        <h2 className="text-[13px] text-muted">Stay close</h2>
        <div className="mt-3 flex gap-4">
          {[
            ['Telegram', 'https://t.me/furtiveapp', <svg key="t" viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13 1.3 11.5c-1-.3-1.1-1 .2-1.5L20.5 2.7c.9-.3 1.7.2 1.4 1.6Z" /></svg>],
            ['X', 'https://x.com/furtiveapp', <svg key="x" viewBox="0 0 24 24" className="size-[18px]" fill="currentColor"><path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>],
            ['Email', 'mailto:hello@furtive.app', <svg key="e" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>],
          ].map(([label, href, icon]) => (
            <motion.button key={label as string} type="button" whileTap={{ scale: 0.9 }} onClick={() => (tap('light'), openLink(href as string))} className="flex flex-col items-center gap-1.5">
              <span className="grid size-12 place-items-center rounded-full bg-ink text-paper">{icon as ReactNode}</span>
              <span className="text-[12px] text-muted">{label as string}</span>
            </motion.button>
          ))}
        </div>
      </section>

      <div className="mt-10 flex flex-col items-center gap-1">
        <button type="button" onClick={() => (tap('light'), onSignOut())} className="rounded-full px-4 py-2 text-[14px] font-medium text-danger">
          Sign out of this phone
        </button>
        <p className="text-[11.5px] text-muted-ink">Furtive 0.1 on testnet</p>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="px-1 text-[13px] text-muted">{title}</h2>
      <div className="mt-1.5 space-y-0.5">{children}</div>
    </section>
  )
}

function Item({ title, sub, onClick, right }: { icon?: ReactNode; title: string; sub: string; onClick?: () => void; right?: ReactNode }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[15.5px]">{title}</span>
        <span className="block truncate text-[12.5px] text-muted">{sub}</span>
      </span>
      {right ?? (onClick ? <span className="text-muted-ink">{Icon.chevron}</span> : null)}
    </>
  )
  return onClick ? (
    <motion.button type="button" whileTap={{ scale: 0.985 }} onClick={() => (tap('light'), onClick())} className="flex w-full items-center gap-3.5 rounded-[18px] px-1 py-3 active:bg-paper-2/60">
      {body}
    </motion.button>
  ) : (
    <div className="flex w-full items-center gap-3.5 px-1 py-2.5">{body}</div>
  )
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={cn('relative h-[28px] w-[46px] shrink-0 rounded-full transition-colors duration-300', on ? 'bg-ink' : 'bg-ink/15')}>
      <motion.span className="absolute top-[3px] size-[22px] rounded-full bg-paper shadow-[0_1px_3px_rgba(22,23,27,.25)]" animate={{ left: on ? 21 : 3 }} transition={spring} />
    </span>
  )
}

const IconBell = <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></svg>
const IconKey = <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l2 2M15 8l2 2" /></svg>
const IconEye = <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
const IconShield = <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6L12 3Z" /><path d="m9 12 2 2 4-4" strokeLinecap="round" /></svg>
const IconChain = <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>

export function PhrasePage({ phrase, onBack }: { phrase: string; onBack: () => void }) {
  const [shown, setShown] = useState(false)
  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="px-5">
        <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
          Recovery <span className="serif">phrase</span>
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">Make sure nobody can see your screen. Anyone with these words can spend your balance.</p>
        <div className="relative mt-6">
          <ol className="grid grid-cols-3 gap-2">
            {phrase.split(' ').map((w, i) => (
              <motion.li key={i} animate={{ filter: shown ? 'blur(0px)' : 'blur(7px)' }} transition={{ delay: shown ? i * 0.03 : 0 }} className="flex items-baseline gap-1.5 rounded-2xl bg-card px-3 py-3 text-[15px] shadow-[0_0_0_1px_rgba(22,23,27,.05)]">
                <span className="w-4 text-[11px] text-muted-ink tabular">{i + 1}</span>
                {w}
              </motion.li>
            ))}
          </ol>
          <AnimatePresence>
            {!shown && (
              <motion.button type="button" exit={{ opacity: 0, scale: 0.9 }} onClick={() => (tap('medium'), setShown(true))} className="absolute inset-0 grid place-items-center">
                <span className="rounded-full bg-ink px-5 py-3 text-[15px] font-medium text-paper shadow-[0_10px_30px_rgba(22,23,27,.25)]">Tap to reveal</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Screen>
  )
}

export function SignOutPage({ onConfirm, onBack }: { onConfirm: () => void; onBack: () => void }) {
  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="flex flex-1 flex-col px-5">
        <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
          Sign out of <span className="serif">this phone?</span>
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">Your money stays safe in the pool. To come back you need your 12 words. Without them nobody can recover it, not even us.</p>
        <div className="safe-b mt-auto space-y-2 pt-8">
          <Button className="bg-danger" onClick={onConfirm}>Sign out</Button>
          <Button variant="soft" onClick={onBack}>Keep me signed in</Button>
        </div>
      </div>
    </Screen>
  )
}

/** What Furtive hides and what it cannot, in plain words and one picture. */
export function PrivacyPage({ onBack }: { onBack: () => void }) {
  const hidden = ['Which wallet a trade came from', 'What you hold and how much', 'Where your money goes when you send it']
  const visible = ['That the pool made a trade, and its size', 'Money going into the pool, and coming out', 'Nothing that names you']
  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="px-5 pb-12">
        <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
          How your privacy <span className="serif">works</span>
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">Your money joins one shared pool. When you trade or send, a proof made on this phone shows the pool you are allowed to, without showing who you are.</p>

        <div className="relative mt-7 overflow-hidden rounded-[28px] bg-ink px-5 pt-6 pb-0 text-paper">
          <div className="flex items-center justify-between text-[12.5px] text-muted-ink">
            <span>You</span>
            <span>The pool</span>
            <span>Anywhere</span>
          </div>
          <div className="relative mt-3 flex items-center justify-between">
            <span className="grid size-12 place-items-center rounded-full bg-paper text-ink">
              <span className="w-[30px]">
                <Peeker look={1} />
              </span>
            </span>
            <motion.span className="h-px flex-1 bg-paper/30" />
            <span className="grid size-16 place-items-center rounded-full border border-paper/25 text-[11px] text-muted-ink">many</span>
            <motion.span className="h-px flex-1 bg-paper/30" />
            <span className="grid size-12 place-items-center rounded-full bg-paper/10 text-[18px]">?</span>
          </div>
          <p className="mt-5 pb-6 text-[13.5px] leading-relaxed text-muted-ink">Everyone's money looks the same inside the pool, so what comes out cannot be traced back to what went in.</p>
        </div>

        <Section title="Hidden" items={hidden} ok />
        <Section title="Still public" items={visible} />

        <h2 className="mt-8 text-[18px] tracking-[-0.02em]">Your money is yours</h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted">The pool has no owner. Nobody at Furtive can move, freeze or take what you hold, and its rules can never be changed. Only the key on this phone can spend your balance.</p>

        <h2 className="mt-7 text-[18px] tracking-[-0.02em]">Stay hard to follow</h2>
        <ul className="mt-2 space-y-2 text-[14.5px] leading-relaxed text-muted">
          <li>Send to a fresh wallet rather than one people know is yours.</li>
          <li>Avoid moving the exact amount you just added.</li>
          <li>Leave some time between adding and sending.</li>
        </ul>
      </div>
    </Screen>
  )
}

function Section({ title, items, ok }: { title: string; items: string[]; ok?: boolean }) {
  return (
    <section className="mt-6">
      <h2 className="px-1 text-[13px] text-muted">{title}</h2>
      <ul className="mt-1.5 space-y-0.5">
        {items.map((t, i) => (
          <li key={t} className="flex items-center gap-3.5 px-1 py-2.5 text-[15px]">
            <span className={cn('w-[30px] shrink-0', ok ? 'text-ink' : 'text-muted-ink')}>
              <Peeker mood={ok ? 'closed' : undefined} look={0.5} />
            </span>
            {t}
          </li>
        ))}
      </ul>
    </section>
  )
}
