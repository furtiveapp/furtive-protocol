import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform, type HTMLMotionProps, type PanInfo } from 'motion/react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { tap, telegramBack } from '@/lib/telegram'

export const cn = (...a: Parameters<typeof clsx>) => twMerge(clsx(a))
export const ease = [0.16, 1, 0.3, 1] as const
export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 } as const
export const soft = { type: 'spring', stiffness: 220, damping: 28 } as const

export type Mood = 'idle' | 'busy' | 'closed' | 'happy'

/**
 * The Peeker, alive. It blinks on its own, and its eyes follow the finger (or
 * cursor) anywhere on screen unless told where to look. Moods: `busy` darts its
 * eyes while it works, `closed` shuts them (hidden balance), `happy` smiles.
 */
export function Peeker({
  className,
  look,
  busy = false,
  mood,
  eye = 'var(--color-paper)',
}: {
  className?: string
  look?: number
  busy?: boolean
  mood?: Mood
  eye?: string
}) {
  const m: Mood = mood ?? (busy ? 'busy' : 'idle')
  const id = useId().replace(/:/g, '')
  const ref = useRef<SVGSVGElement>(null)
  const [blink, setBlink] = useState(false)
  const [dart, setDart] = useState(0.7)
  const x = useMotionValue(look ?? 0.4)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 180, damping: 22 })
  const sy = useSpring(y, { stiffness: 180, damping: 22 })
  const px = useTransform(sx, (v) => v * 30)
  const py = useTransform(sy, (v) => v * 14)

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true)
        setTimeout(() => setBlink(false), 130)
        loop()
      }, 2200 + Math.random() * 2600)
    }
    loop()
    return () => clearTimeout(t)
  }, [])

  // Eyes follow the finger unless a direction is given.
  useEffect(() => {
    if (look !== undefined || m === 'busy') {
      x.set(look ?? 0)
      y.set(0)
      return
    }
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const cx = r.left + r.width / 2
      const cy = r.top + r.height * 0.45
      x.set(Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.45))))
      y.set(Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.45))))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerdown', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onMove)
    }
  }, [look, m, x, y])

  useEffect(() => {
    if (m !== 'busy') return
    const t = setInterval(() => setDart((d) => (d > 0 ? -0.9 : 0.9)), 480)
    return () => clearInterval(t)
  }, [m])
  useEffect(() => {
    if (m === 'busy') x.set(dart)
  }, [dart, m, x])

  const EYES = 'M102 168 H286 C286 286 102 286 102 168 Z M314 168 H498 C498 286 314 286 314 168 Z'
  const shut = m === 'closed' || blink

  return (
    <svg ref={ref} viewBox="0 0 600 404" className={cn('block h-auto overflow-visible', className)} aria-hidden="true">
      <path d="M0 406 V340 C0 152 112 0 300 0 C488 0 600 152 600 340 V406 Z" fill="currentColor" />
      {m === 'happy' ? (
        <motion.g initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={soft} fill="none" stroke={eye} strokeWidth="34" strokeLinecap="round">
          <path d="M122 232 Q194 150 266 232" />
          <path d="M334 232 Q406 150 478 232" />
        </motion.g>
      ) : (
        <motion.g style={{ originY: '200px' }} animate={{ scaleY: shut ? 0.07 : 1 }} transition={{ duration: m === 'closed' ? 0.25 : 0.09, ease }}>
          <path d={EYES} fill={eye} />
          <clipPath id={`pe-${id}`}>
            <path d={EYES} />
          </clipPath>
          <motion.g clipPath={`url(#pe-${id})`} style={{ x: px, y: py }}>
            <circle cx="194" cy="206" r="46" fill="currentColor" />
            <circle cx="406" cy="206" r="46" fill="currentColor" />
          </motion.g>
        </motion.g>
      )}
    </svg>
  )
}

/** Static mark for small places. */
export function Mark({ className }: { className?: string }) {
  return <Peeker className={className} />
}

export function Button({
  children,
  variant = 'ink',
  className,
  onClick,
  disabled,
  ...rest
}: Omit<HTMLMotionProps<'button'>, 'children'> & { variant?: 'ink' | 'soft' | 'ghost' | 'light'; children: ReactNode }) {
  return (
    <motion.button
      type="button"
      {...rest}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={spring}
      onClick={(e) => {
        tap('light')
        onClick?.(e)
      }}
      className={cn(
        'relative inline-flex h-[56px] w-full items-center justify-center gap-2 overflow-hidden rounded-full text-[16px] font-medium transition-opacity duration-300 disabled:opacity-30',
        variant === 'ink' && 'bg-ink text-paper',
        variant === 'light' && 'bg-paper text-ink',
        variant === 'soft' && 'bg-paper-2 text-ink',
        variant === 'ghost' && 'h-12 text-muted',
        className,
      )}
    >
      {children}
    </motion.button>
  )
}

/** A round action with its label underneath, as on the home screen. */
export function Action({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <motion.button
      type="button"
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      transition={spring}
      onClick={() => (tap('light'), onClick())}
      className="flex flex-col items-center gap-2 disabled:opacity-30"
    >
      <span className="grid size-[60px] place-items-center rounded-full bg-ink text-paper">{icon}</span>
      <span className="text-[13.5px] font-medium">{label}</span>
    </motion.button>
  )
}

/** A screen in a stack. Slides in from the side it was opened from. */
export function Screen({ children, dir = 1, className }: { children: ReactNode; dir?: number; className?: string }) {
  return (
    <motion.main
      custom={dir}
      variants={{
        enter: (d: number) => ({ x: d * 48, opacity: 0 }),
        center: { x: 0, opacity: 1 },
        exit: (d: number) => ({ x: d * -32, opacity: 0 }),
      }}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ x: spring, opacity: { duration: 0.25 } }}
      className={cn('mx-auto flex min-h-svh w-full max-w-[460px] flex-col', className)}
    >
      {children}
    </motion.main>
  )
}

export function TopBar({ title, onBack, right }: { title?: string; onBack?: () => void; right?: ReactNode }) {
  // Telegram's own back button mirrors ours, so the app feels native.
  useEffect(() => telegramBack(onBack ?? null), [onBack])
  return (
    <header className="flex h-14 items-center gap-1 px-3">
      {onBack && (
        <motion.button type="button" whileTap={{ scale: 0.85 }} onClick={() => (tap('light'), onBack())} aria-label="Back" className="grid size-11 place-items-center rounded-full">
          <svg viewBox="0 0 24 24" className="size-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </motion.button>
      )}
      {title && <h1 className="text-[17px] font-medium tracking-[-0.01em]">{title}</h1>}
      <div className="ml-auto">{right}</div>
    </header>
  )
}

/** A bottom sheet. Drag it down, or tap outside, to close. */
export function Sheet({ open, onClose, children, locked = false }: { open: boolean; onClose: () => void; children: ReactNode; locked?: boolean }) {
  const y = useMotionValue(0)
  const backdrop = useTransform(y, [0, 400], [1, 0])
  const end = (_: unknown, info: PanInfo) => {
    if (!locked && (info.offset.y > 120 || info.velocity.y > 600)) onClose()
    else animate(y, 0, spring)
  }
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-ink/35"
            style={{ opacity: backdrop }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !locked && onClose()}
          />
          <motion.section
            role="dialog"
            className="absolute inset-x-0 bottom-0 mx-auto max-w-[460px] rounded-t-[32px] bg-paper shadow-[0_-20px_60px_rgba(22,23,27,.18)]"
            style={{ y }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={spring}
            drag={locked ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.6 }}
            onDragEnd={end}
          >
            <div className="flex justify-center pt-2.5 pb-1">
              <span className="h-1.5 w-10 rounded-full bg-ink/12" />
            </div>
            <motion.div layout transition={spring} className="safe-b px-5 pt-2">
              {children}
            </motion.div>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  )
}

/** A number that counts to its new value instead of jumping. */
export function Ticker({ value, format }: { value: number; format: (n: number) => string }) {
  const mv = useMotionValue(value)
  const [shown, setShown] = useState(format(value))
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.9, ease, onUpdate: (v) => setShown(format(v)) })
    return () => c.stop()
  }, [value, format, mv])
  return <span className="tabular">{shown}</span>
}

// pathLength is a motion value; React's CSS types do not know it.
const draw = (v: number) => ({ pathLength: v }) as Record<string, number>

/** A tick that draws itself. */
export function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 52 52" className={className} fill="none">
      <motion.circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="2" initial={draw(0)} animate={draw(1)} transition={{ duration: 0.6, ease }} />
      <motion.path d="M15 27l7 7 15-16" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" initial={draw(0)} animate={draw(1)} transition={{ duration: 0.45, delay: 0.45, ease }} />
    </svg>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <motion.span className={cn('inline-block size-4 rounded-full border-2 border-current border-r-transparent', className)} animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} />
}

/** Words that rise in one after another. */
export function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.8, delay, ease }}>
      {children}
    </motion.div>
  )
}

export const Icon = {
  plus: <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  send: <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7M9 7h8v8" /></svg>,
  trade: <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v14M3.5 14.5 7 18l3.5-3.5M17 20V6M13.5 9.5 17 6l3.5 3.5" /></svg>,
  copy: <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>,
  eye: <svg viewBox="0 0 24 24" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" /><path d="M4 4l16 16" /></svg>,
  refresh: <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>,
  chevron: <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>,
  eth: <svg viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d="M12 2 5.5 12.3 12 16l6.5-3.7L12 2Zm0 15.3-6.5-3.8L12 22l6.5-8.5-6.5 3.8Z" /></svg>,
}
