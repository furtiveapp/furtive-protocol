import { AddSheet } from '@/screens/Home'
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { accountFromPhrase, type Account } from '@sdk/wallet.mjs'
import { Peeker, Screen, TopBar, ease } from '@/components/ui'
import { forgetPhrase, initData, loadPhrase, savePhrase, telegramBack } from '@/lib/telegram'
import { loadWallet, setAlerts, txInFlight, type Activity, type Wallet, warmUp } from '@/lib/furtive'
import type { MarketPool } from '@/lib/markets-api'
import { findToken, units, type Token, checkToken } from '@/lib/market'
import { Welcome, Backup, Restore } from '@/screens/Onboarding'
import { Home } from '@/screens/Home'
import { Discover } from '@/screens/Discover'
import { TokenPage } from '@/screens/TokenPage'
import { TradeSheet } from '@/screens/Trade'
import { HeldPicker, OrderSheet, OrdersList } from '@/screens/Orders'
import { loadOrders, syncOrders, type OrderKind } from '@/lib/orders'
import { AccountTab, ActivityTab, PhrasePage, PrivacyPage, Receipt, SignOutPage, TabBar, type Tab } from '@/screens/Tabs'

type View = 'loading' | 'welcome' | 'backup' | 'restore' | 'app'
type Page =
  | { kind: 'token'; pool: MarketPool }
  | { kind: 'trade'; token: Token; side?: 'buy' | 'sell'; amount?: string; auto?: boolean; expect?: string }
  | { kind: 'order'; token: Token; start?: { kind?: OrderKind; pct?: number; amount?: string; portion?: number; auto?: boolean } }
  | { kind: 'orders' }
  | { kind: 'pick'; order: OrderKind }
  | { kind: 'receipt'; activity: Activity }
  | { kind: 'privacy' }
  | { kind: 'add' }
  | { kind: 'phrase' }
  | { kind: 'signout' }

export default function App() {
  const [view, setView] = useState<View>('loading')
  const [account, setAccount] = useState<Account | null>(null)
  const [phrase, setPhrase] = useState('')
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [stack, setStack] = useState<Page[]>([])
  const [tradeLocked, setTradeLocked] = useState(false)
  const [held, setHeld] = useState<{ address: string; symbol: string; amount: bigint; decimals: number }[]>([])

  // Tokens held privately, with their symbols: for alerts and for "Sell half" links.
  const heldKey = wallet ? [...wallet.balance.entries()].filter(([a, v]) => a !== 0n && v > 0n).map(([a, v]) => `${a}:${v}`).join(',') : ''
  useEffect(() => {
    if (!wallet) return
    let live = true
    Promise.all(
      [...wallet.balance.entries()]
        .filter(([a, v]) => a !== 0n && v > 0n)
        .map(async ([a, amount]) => {
          const t = await findToken('0x' + a.toString(16).padStart(40, '0'))
          return t ? { address: t.address, symbol: t.symbol, amount, decimals: t.decimals } : null
        }),
    ).then((l) => {
      if (!live) return
      const list = l.filter(Boolean) as typeof held
      setHeld(list)
      // keep the bot's watch list in step with what is held, if alerts are on
      try {
        if (localStorage.getItem('furtive.alerts') === '1' && initData()) setAlerts(true, list.map(({ address, symbol }) => ({ address, symbol })), initData()).catch(() => {})
      } catch {}
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey])

  const push = (p: Page) => setStack((s) => [...s, p])
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const page = stack.at(-1)

  const open = async (p: string, save: boolean) => {
    const acct = await accountFromPhrase(p)
    if (save) await savePhrase(p)
    setAccount(acct)
    setPhrase(p)
    setTab('home')
    setStack([])
    setView('app')
  }

  // Fetch the proof files the moment Furtive opens. A new person is writing down
  // their 12 words meanwhile, so the first trade finds them ready.
  useEffect(() => warmUp(), [])

  useEffect(() => {
    loadPhrase().then((p) => (p ? open(p, false).catch(() => setView('welcome')) : setView('welcome')))
  }, [])

  const refresh = useCallback(async () => {
    if (!account || txInFlight()) return
    setLoading(true)
    setError(null)
    try {
      setWallet(await loadWallet(account))
      // orders that filled, expired or were cancelled show in Activity even off the Orders screen
      if (loadOrders(account).length) syncOrders(account).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'Could not reach the network.')
    } finally {
      setLoading(false)
    }
  }, [account])

  // The balance keeps itself current: on opening, every 12 seconds, and whenever
  // the app comes back to the foreground.
  useEffect(() => {
    if (view !== 'app') return
    refresh()
    const id = setInterval(() => document.visibilityState === 'visible' && refresh(), 12_000)
    const onShow = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onShow)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [view, refresh])

  // Opened from a chat order ("buy 0.01 TSLA"): go straight to that trade, filled in.
  useEffect(() => {
    if (view !== 'app') return
    const q = new URLSearchParams(window.location.search)
    const open = q.get('open')
    if (open === 'account' || open === 'activity' || open === 'add' || open === 'orders') {
      window.history.replaceState(null, '', window.location.pathname)
      if (open === 'add' || open === 'orders') push({ kind: open })
      else setTab(open)
      return
    }
    // /stop or /tp in the chat, with no token named: pick from what this phone holds
    const pick = q.get('pick')
    if (pick === 'stop' || pick === 'take') {
      window.history.replaceState(null, '', window.location.pathname)
      push({ kind: 'pick', order: pick })
      return
    }
    // Opened from /limit or /stop in the chat: the order screen, filled in
    const orderAddr = q.get('order')
    if (orderAddr) {
      window.history.replaceState(null, '', window.location.pathname)
      const k = q.get('kind')
      const kind = k === 'limit' || k === 'stop' || k === 'take' ? k : undefined
      findToken(orderAddr).then((token) => token && push({ kind: 'order', token, start: { kind, pct: Number(q.get('pct')) || undefined, amount: q.get('amount') || undefined, portion: Number(q.get('portion')) || undefined, auto: q.get('go') === '1' } }))
      return
    }
    const addr = q.get('trade')
    if (!addr) return
    window.history.replaceState(null, '', window.location.pathname)
    findToken(addr).then(async (token) => {
      if (!token) return
      checkToken(token).catch(() => {}) // start the safety check while the screen opens
      let amount = q.get('amount') || undefined
      const portion = Number(q.get('portion'))
      // "Sell all" / "Sell half" from a Heads up alert: that share of what is held
      if (portion > 0 && portion <= 1 && account) {
        const w = wallet ?? (await loadWallet(account).catch(() => null))
        const have = w?.balance.get(BigInt(token.address)) ?? 0n
        const part = portion === 1 ? have : (have * BigInt(Math.round(portion * 1000))) / 1000n
        if (part > 0n) amount = units(part, token.decimals, token.decimals).replace(/,/g, '')
      }
      push({ kind: 'trade', token, side: q.get('side') === 'sell' ? 'sell' : 'buy', amount, auto: q.get('go') === '1', expect: q.get('out') || undefined })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // Telegram's back button pops pages; on a tab other than Home it goes Home.
  useEffect(() => {
    if (view !== 'app') return
    if (page) return telegramBack(tradeLocked ? null : pop)
    if (tab !== 'home') return telegramBack(() => setTab('home'))
    return telegramBack(null)
  }, [view, page, tab, pop, tradeLocked])

  const signOut = async () => {
    await forgetPhrase()
    setAccount(null)
    setPhrase('')
    setWallet(null)
    setStack([])
    setView('welcome')
  }

  if (view !== 'app' || !account) {
    return (
      <AnimatePresence mode="wait">
        {view === 'loading' && (
          <motion.div key="loading" exit={{ opacity: 0 }} className="grid min-h-svh place-items-center">
            <div className="w-[64px]">
              <Peeker busy />
            </div>
          </motion.div>
        )}
        {view === 'welcome' && <Welcome key="welcome" onCreate={() => setView('backup')} onRestore={() => setView('restore')} />}
        {view === 'backup' && <Backup key="backup" onBack={() => setView('welcome')} onDone={(p) => open(p, true)} />}
        {view === 'restore' && <Restore key="restore" onBack={() => setView('welcome')} onDone={(p) => open(p, true)} />}
      </AnimatePresence>
    )
  }

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {page ? (
          <motion.div key={`page-${stack.length}-${page.kind}`} initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.35, ease }}>
            {page.kind === 'token' && <TokenPage pool={page.pool} onBack={pop} onTrade={(token) => push({ kind: 'trade', token })} />}
            {page.kind === 'receipt' && <Receipt a={page.activity} onBack={pop} />}
            {page.kind === 'privacy' && <PrivacyPage onBack={pop} />}
            {page.kind === 'add' && (
              <Screen>
                <TopBar onBack={pop} />
                <div className="px-5 pb-10">{wallet ? <AddSheet account={account} wallet={wallet} onDone={() => (pop(), refresh())} /> : <div className="h-64 animate-pulse rounded-3xl bg-ink/[0.04]" />}</div>
              </Screen>
            )}
            {page.kind === 'phrase' && <PhrasePage phrase={phrase} onBack={pop} />}
            {page.kind === 'signout' && <SignOutPage onBack={pop} onConfirm={signOut} />}
            {page.kind === 'pick' && (
              <Screen>
                <TopBar onBack={pop} />
                <div className="px-5">{wallet ? <HeldPicker wallet={wallet} kind={page.order} onPick={(token) => (pop(), push({ kind: 'order', token, start: { kind: page.order } }))} /> : <div className="h-64 animate-pulse rounded-3xl bg-ink/[0.04]" />}</div>
              </Screen>
            )}
            {page.kind === 'orders' && (
              <Screen>
                <TopBar onBack={pop} />
                <div className="px-5">
                  <OrdersList account={account} onRefresh={refresh} />
                </div>
              </Screen>
            )}
            {page.kind === 'order' && (
              <Screen>
                <TopBar onBack={tradeLocked ? undefined : pop} right={<button type="button" onClick={() => push({ kind: 'orders' })} className="px-3 text-[14px] font-medium text-muted">Your orders</button>} />
                <div className="px-5 pb-10">
                  {wallet ? (
                    <OrderSheet account={account} wallet={wallet} token={page.token} start={page.start} onLock={setTradeLocked} onDone={() => (pop(), push({ kind: 'orders' }), refresh())} />
                  ) : (
                    <div className="h-64 animate-pulse rounded-3xl bg-ink/[0.04]" />
                  )}
                </div>
              </Screen>
            )}
            {page.kind === 'trade' && (
              <Screen>
                <TopBar onBack={tradeLocked ? undefined : pop} />
                <div className="px-5 pb-10">
                  {wallet ? (
                    <TradeSheet
                      account={account}
                      wallet={wallet}
                      start={{ token: page.token, side: page.side ?? 'buy', amount: page.amount, auto: page.auto, expect: page.expect }}
                      onLock={setTradeLocked}
                      onRefresh={refresh}
                      onOrder={(token) => push({ kind: 'order', token })}
                      onDone={() => {
                        pop()
                        setTab('home')
                        refresh()
                      }}
                    />
                  ) : (
                    <div className="h-64 animate-pulse rounded-3xl bg-ink/[0.04]" />
                  )}
                </div>
              </Screen>
            )}
          </motion.div>
        ) : (
          <motion.div key={`tab-${tab}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="mx-auto min-h-svh max-w-[460px]">
            {tab === 'home' && (
              <Home account={account} phrase={phrase} wallet={wallet} loading={loading} error={error} onRefresh={refresh} onSignOut={() => push({ kind: 'signout' })} onSeeAll={() => setTab('activity')} onOrder={(token) => push({ kind: 'order', token })} />
            )}
            {tab === 'discover' && <Discover onOpen={(pool) => push({ kind: 'token', pool })} onOpenTest={(token) => push({ kind: 'trade', token })} />}
            {tab === 'activity' && <ActivityTab account={account} onOpen={(activity) => push({ kind: 'receipt', activity })} />}
            {tab === 'account' && <AccountTab address={wallet?.depositAddress ?? ''} holdings={held.map(({ address, symbol }) => ({ address, symbol }))} onPrivacy={() => push({ kind: 'privacy' })} onPhrase={() => push({ kind: 'phrase' })} onSignOut={() => push({ kind: 'signout' })} onOrders={() => push({ kind: 'orders' })} />}
          </motion.div>
        )}
      </AnimatePresence>
      {!page && <TabBar tab={tab} onTab={setTab} />}
    </>
  )
}
