import { useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { tap } from '@/lib/telegram'

/**
 * A price line you can scrub with a finger. Calls onScrub with the point under
 * the finger, or null when let go.
 */
export function Chart({ points, up, onScrub }: { points: [number, number][]; up: boolean; onScrub?: (p: [number, number] | null) => void }) {
  const W = 360
  const H = 180
  const ref = useRef<SVGSVGElement>(null)
  const [at, setAt] = useState<number | null>(null)

  const { path, area, xy } = useMemo(() => {
    if (points.length < 2) return { path: '', area: '', xy: [] as [number, number][] }
    const ys = points.map((p) => p[1])
    const min = Math.min(...ys)
    const max = Math.max(...ys)
    const span = max - min || 1
    const xy = points.map((p, i) => [(i / (points.length - 1)) * W, 12 + (1 - (p[1] - min) / span) * (H - 24)] as [number, number])
    const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
    return { path, area: `${path}L${W} ${H}L0 ${H}Z`, xy }
  }, [points])

  const color = up ? '#3F8F5E' : '#B4442C'

  const move = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r || xy.length < 2) return
    const i = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (xy.length - 1))
    if (i !== at) {
      setAt(i)
      onScrub?.(points[i])
      if (i % 4 === 0) tap('light')
    }
  }
  const end = () => {
    setAt(null)
    onScrub?.(null)
  }

  if (points.length < 2) return <div className="grid h-[180px] place-items-center text-[13.5px] text-muted-ink">Chart unavailable right now</div>

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-[180px] w-full touch-none"
      onPointerDown={(e) => move(e.clientX)}
      onPointerMove={(e) => (e.buttons || e.pointerType === 'touch') && move(e.clientX)}
      onPointerUp={end}
      onPointerLeave={end}
    >
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill="url(#chart-fill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8 }} />
      <motion.path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 } as Record<string, number>}
        animate={{ pathLength: 1 } as Record<string, number>}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />
      {at !== null && xy[at] && (
        <g>
          <line x1={xy[at][0]} x2={xy[at][0]} y1="0" y2={H} stroke="#16171B" strokeOpacity="0.15" vectorEffect="non-scaling-stroke" />
          <circle cx={xy[at][0]} cy={xy[at][1]} r="4.5" fill={color} stroke="#FBF9F5" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  )
}
