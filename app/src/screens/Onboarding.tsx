import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { newPhrase, isValidPhrase } from '@sdk/wallet.mjs'
import { Button, Peeker, Rise, Screen, TopBar, ease, spring, cn } from '@/components/ui'
import { notify, tap } from '@/lib/telegram'

export function Welcome({ onCreate, onRestore }: { onCreate: () => void; onRestore: () => void }) {
  return (
    <Screen className="px-3 pt-3">
      {/* The stage: the Peeker rises from its bottom edge. */}
      <motion.section
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, ease }}
        className="relative flex min-h-[46svh] flex-1 items-end justify-center overflow-hidden rounded-[36px] bg-ink"
      >
        <div className="pointer-events-none absolute -top-1/3 left-1/2 h-[90%] w-[130%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(243,239,231,.16),transparent)]" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(rgba(243,239,231,1)_1px,transparent_1px)] [background-size:18px_18px]" />
        <span className="absolute top-5 left-6 text-[17px] font-medium tracking-[-0.03em] text-paper">furtive</span>
        <motion.div initial={{ y: '100%' }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 120, damping: 18, delay: 0.35 }} className="w-[58%] max-w-[240px] text-paper">
          <Peeker eye="var(--color-ink)" look={0.7} />
        </motion.div>
      </motion.section>

      <div className="px-3 pt-8">
        <Rise delay={0.2}>
          <h1 className="text-[34px] leading-[1.04] tracking-[-0.045em]">
            Trade like nobody's looking, <span className="serif">because nobody is.</span>
          </h1>
        </Rise>
        <Rise delay={0.32}>
          <p className="mt-3 text-[15.5px] leading-relaxed text-muted">Private trading on Robinhood Chain. Your keys never leave this phone.</p>
        </Rise>
        <Rise delay={0.44} className="safe-b mt-7 space-y-1">
          <Button onClick={onCreate}>Create my account</Button>
          <Button variant="ghost" onClick={onRestore}>I already have a recovery phrase</Button>
        </Rise>
      </div>
    </Screen>
  )
}

/** Shows the twelve words, then checks two of them before going on. */
export function Backup({ onDone, onBack }: { onDone: (phrase: string) => void; onBack: () => void }) {
  const phrase = useMemo(() => newPhrase(), [])
  const words = phrase.split(' ')
  const [shown, setShown] = useState(false)
  const [checking, setChecking] = useState(false)

  return (
    <AnimatePresence mode="wait" initial={false}>
      {checking ? (
        <Confirm key="confirm" words={words} onBack={() => setChecking(false)} onDone={() => onDone(phrase)} />
      ) : (
        <Screen key="words">
          <TopBar onBack={onBack} />
          <div className="flex flex-1 flex-col px-5">
            <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
              Your recovery <span className="serif">phrase</span>
            </h1>
            <p className="mt-3 text-[15.5px] leading-relaxed text-muted">
              These 12 words are your account. Write them on paper and keep it safe. Without them nobody can get it back, not even us.
            </p>
            <div className="relative mt-7">
              <ol className="grid grid-cols-3 gap-2">
                {words.map((w, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, filter: shown ? 'blur(0px)' : 'blur(7px)' }}
                    transition={{ delay: shown ? i * 0.035 : i * 0.02, duration: 0.45, ease }}
                    className="flex items-baseline gap-1.5 rounded-2xl bg-card px-3 py-3 text-[15px] shadow-[0_0_0_1px_rgba(22,23,27,.05)]"
                  >
                    <span className="w-4 text-[11px] text-muted-ink tabular">{i + 1}</span>
                    {w}
                  </motion.li>
                ))}
              </ol>
              <AnimatePresence>
                {!shown && (
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={spring}
                    onClick={() => (tap('medium'), setShown(true))}
                    className="absolute inset-0 grid place-items-center"
                  >
                    <span className="rounded-full bg-ink px-5 py-3 text-[15px] font-medium text-paper shadow-[0_10px_30px_rgba(22,23,27,.25)]">Tap to reveal</span>
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <p className="mt-5 text-[13.5px] leading-relaxed text-muted">Never share them or type them into a website. Furtive will never ask for them.</p>
            <div className="safe-b mt-auto pt-8">
              <Button disabled={!shown} onClick={() => setChecking(true)}>I wrote them down</Button>
            </div>
          </div>
        </Screen>
      )}
    </AnimatePresence>
  )
}

function Confirm({ words, onDone, onBack }: { words: string[]; onDone: () => void; onBack: () => void }) {
  const asks = useMemo(() => {
    const picks = new Set<number>()
    while (picks.size < 2) picks.add(Math.floor(Math.random() * 12))
    return [...picks].sort((a, b) => a - b).map((i) => {
      const options = new Set([words[i]])
      while (options.size < 3) options.add(words[Math.floor(Math.random() * 12)])
      return { i, options: [...options].sort(() => Math.random() - 0.5) }
    })
  }, [words])
  const [step, setStep] = useState(0)
  const [wrong, setWrong] = useState<string | null>(null)
  const ask = asks[step]

  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="px-5">
        <div className="flex gap-1.5">
          {asks.map((_, i) => (
            <motion.span key={i} className="h-1 flex-1 rounded-full bg-ink" animate={{ opacity: i <= step ? 1 : 0.12 }} transition={{ duration: 0.4 }} />
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={spring} className="mt-10">
            <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
              Which is word <span className="serif">{ask.i + 1}?</span>
            </h1>
            <div className="mt-8 grid gap-2">
              {ask.options.map((o) => (
                <motion.button
                  key={o}
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  animate={wrong === o ? { x: [0, -8, 8, -5, 0] } : { x: 0 }}
                  transition={{ duration: 0.35 }}
                  onClick={() => {
                    if (o === words[ask.i]) {
                      tap('light')
                      setWrong(null)
                      if (step + 1 < asks.length) setStep(step + 1)
                      else (notify('success'), onDone())
                    } else {
                      notify('error')
                      setWrong(o)
                    }
                  }}
                  className={cn('h-[58px] rounded-2xl bg-card text-[16px] shadow-[0_0_0_1px_rgba(22,23,27,.06)]', wrong === o && 'text-danger shadow-[0_0_0_1.5px_var(--color-danger)]')}
                >
                  {o}
                </motion.button>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </Screen>
  )
}

export function Restore({ onDone, onBack }: { onDone: (phrase: string) => void; onBack: () => void }) {
  const [text, setText] = useState('')
  const clean = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const count = clean ? clean.split(' ').length : 0
  const valid = count === 12 && isValidPhrase(clean)

  return (
    <Screen>
      <TopBar onBack={onBack} />
      <div className="flex flex-1 flex-col px-5">
        <h1 className="text-[30px] leading-[1.06] tracking-[-0.04em]">
          Welcome <span className="serif">back.</span>
        </h1>
        <p className="mt-3 text-[15.5px] leading-relaxed text-muted">Enter your 12 words in order.</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-6 w-full resize-none rounded-[22px] bg-card p-4 text-[16px] leading-relaxed shadow-[0_0_0_1px_rgba(22,23,27,.06)] outline-none transition-shadow focus:shadow-[0_0_0_1.5px_var(--color-ink)]"
        />
        <div className="mt-3 flex items-center gap-2 text-[13.5px]">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink/8">
            <motion.div className="h-full rounded-full bg-ink" animate={{ width: `${(Math.min(count, 12) / 12) * 100}%` }} transition={spring} />
          </div>
          <span className={cn('tabular', count === 12 && !valid ? 'text-danger' : 'text-muted')}>{count === 12 && !valid ? 'Check the spelling' : `${count}/12`}</span>
        </div>
        <div className="safe-b mt-auto pt-8">
          <Button disabled={!valid} onClick={() => onDone(clean)}>Restore my account</Button>
        </div>
      </div>
    </Screen>
  )
}
