import { formatEther, parseEther } from 'viem'

/** ETH for people: up to 6 decimals, trailing zeros trimmed. */
export function eth(wei: bigint) {
  const s = formatEther(wei)
  const [i, d = ''] = s.split('.')
  const dec = d.slice(0, 6).replace(/0+$/, '')
  return dec ? `${Number(i).toLocaleString('en-US')}.${dec}` : Number(i).toLocaleString('en-US')
}

/** Parses what a person typed; null when it is not a usable amount. */
export function parseAmount(input: string): bigint | null {
  const v = input.trim().replace(',', '.')
  if (!/^\d*\.?\d{0,18}$/.test(v) || v === '' || v === '.') return null
  try {
    const n = parseEther(v)
    return n > 0n ? n : null
  } catch {
    return null
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
