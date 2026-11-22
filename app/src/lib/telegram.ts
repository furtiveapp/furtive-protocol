// Telegram Mini App helpers. Everything degrades gracefully in a normal browser.
type Haptic = 'light' | 'medium' | 'rigid'
type SecureStorage = {
  setItem(key: string, value: string, cb?: (err: unknown, ok?: boolean) => void): void
  getItem(key: string, cb: (err: unknown, value?: string | null) => void): void
  removeItem(key: string, cb?: (err: unknown, ok?: boolean) => void): void
}
type WebApp = {
  ready(): void
  close?(): void
  expand(): void
  setHeaderColor?(c: string): void
  setBackgroundColor?(c: string): void
  disableVerticalSwipes?(): void
  HapticFeedback?: { impactOccurred(s: Haptic): void; notificationOccurred(s: 'success' | 'error' | 'warning'): void }
  SecureStorage?: SecureStorage
  initData?: string
  initDataUnsafe?: { user?: { first_name?: string } }
  openLink?(url: string): void
  readTextFromClipboard?(cb: (text: string | null) => void): void
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
}

export const tg = (): WebApp | undefined => (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp

export function initTelegram() {
  const app = tg()
  if (!app) return
  app.ready()
  app.expand()
  app.setHeaderColor?.('#F3EFE7')
  app.setBackgroundColor?.('#F3EFE7')
  app.disableVerticalSwipes?.()
}

/** Telegram's signed launch data, proving which chat the app was opened from. */
export const initData = () => tg()?.initData || ''

export const tap = (s: Haptic = 'light') => tg()?.HapticFeedback?.impactOccurred(s)
export const notify = (s: 'success' | 'error' | 'warning') => tg()?.HapticFeedback?.notificationOccurred(s)

/** One-tap: a trade confirmed in the chat runs the moment the app opens. On by default. */
export const oneTap = () => {
  try {
    return localStorage.getItem('furtive.onetap') !== '0'
  } catch {
    return true
  }
}
export const setOneTap = (on: boolean) => {
  try {
    localStorage.setItem('furtive.onetap', on ? '1' : '0')
  } catch {}
}

/** Inside Telegram: close the app and land back in the chat. */
export const inTelegram = () => !!tg()?.initData
export const backToChat = () => tg()?.close?.()

export function openLink(url: string) {
  const app = tg()
  if (app?.openLink) app.openLink(url)
  else window.open(url, '_blank', 'noopener')
}

// ─────────────────────────────── where the recovery phrase lives on this device

const KEY = 'furtive.phrase.v1'

/** Telegram's SecureStorage keeps it in the phone's keychain. Only inside a real
 *  Telegram session: in a plain browser the object exists but never answers. */
function secure(): SecureStorage | undefined {
  const app = tg()
  return app?.initData ? app.SecureStorage : undefined
}

/** Settles with `fallback` if Telegram does not answer in time. */
function withTimeout<T>(p: Promise<T>, fallback: () => T, ms = 2500): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback()), ms))])
}

/** Keychain when Telegram offers it; this device's local storage only otherwise. */
export function savePhrase(phrase: string): Promise<void> {
  const s = secure()
  if (!s) {
    localSet(phrase)
    return Promise.resolve()
  }
  return withTimeout(
    new Promise<void>((resolve) => {
      s.setItem(KEY, phrase, (err, ok) => {
        if (err || ok === false) localSet(phrase)
        resolve()
      })
    }),
    () => localSet(phrase),
  )
}

export function loadPhrase(): Promise<string | null> {
  return withTimeout(new Promise((resolve) => {
    const s = secure()
    if (s) {
      s.getItem(KEY, (err, value) => resolve(!err && value ? value : localGet()))
      return
    }
    resolve(localGet())
  }), localGet)
}

export function forgetPhrase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      localStorage.removeItem(KEY)
    } catch {}
    const s = secure()
    if (s) s.removeItem(KEY, () => resolve())
    else resolve()
  })
}

function localSet(v: string) {
  try {
    localStorage.setItem(KEY, v)
  } catch {}
}
function localGet(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Shows Telegram's own back button while `onBack` is set. Returns a cleanup. */
export function telegramBack(onBack: (() => void) | null): () => void {
  const b = tg()?.BackButton
  if (!b || !tg()?.initData) return () => {}
  if (!onBack) {
    b.hide()
    return () => {}
  }
  b.onClick(onBack)
  b.show()
  return () => {
    b.offClick(onBack)
    b.hide()
  }
}

/** Reads the clipboard, through Telegram when inside it. */
export async function pasteText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()) || ''
  } catch {
    return ''
  }
}
