// The Rescue page: walks a person through taking everything out, in four steps.
import { getAddress, isAddress, type Address } from 'viem'
import { DEFAULT_NETWORK, find, rescue, show, sweepDropOff, type Found, type Network, type ProofFiles, type Step } from './rescue'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// Network settings, editable
$<HTMLInputElement>('rpc').value = DEFAULT_NETWORK.rpc
$<HTMLInputElement>('vault').value = DEFAULT_NETWORK.vault
$<HTMLInputElement>('chainId').value = String(DEFAULT_NETWORK.chainId)
$<HTMLInputElement>('fromBlock').value = String(DEFAULT_NETWORK.fromBlock)
const network = (): Network => ({
  ...DEFAULT_NETWORK,
  rpc: $<HTMLInputElement>('rpc').value.trim(),
  vault: getAddress($<HTMLInputElement>('vault').value.trim()),
  chainId: Number($<HTMLInputElement>('chainId').value.trim()),
  fromBlock: BigInt($<HTMLInputElement>('fromBlock').value.trim()),
})

// The proof files: inside this page when it was saved as one file, otherwise next to it.
async function bytes(id: string, url: string): Promise<Uint8Array> {
  const inline = document.getElementById(id)?.textContent?.trim()
  const raw = inline ? new Response(Uint8Array.from(atob(inline), (c) => c.charCodeAt(0))).body! : (await fetch(url)).body!
  return new Uint8Array(await new Response(raw.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
}
let files: Promise<ProofFiles> | null = null
const proofFiles = () =>
  (files ??= Promise.all([bytes('zk-wasm', ZK_WASM), bytes('zk-zkey', ZK_ZKEY)]).then(([wasm, zkey]) => ({ wasm: { type: 'mem', data: wasm }, zkey: { type: 'mem', data: zkey } })))
declare const ZK_WASM: string
declare const ZK_ZKEY: string

// the download link saves this very page, wherever it is hosted
const save = document.getElementById('save') as HTMLAnchorElement | null
if (save) save.href = location.href.split('#')[0]
// opened from a saved copy: it already is the download
if (location.protocol === 'file:') $('foot').textContent = 'This saved copy works on its own, even if furtive.app is ever unreachable. The Furtive vault has no owner and cannot be switched off.'

let phrase = ''
let found: Found | null = null
let poll: ReturnType<typeof setInterval> | null = null
const withdrawals = () => (found ? found.holdings.reduce((n, h) => n + Math.ceil(h.notes.length / 2), 0) : 0)
const needed = () => (found ? BigInt(withdrawals()) * found.feePerWithdrawal + 21_000n * found.feePerWithdrawal / 450_000n : 0n)

function renderHoldings() {
  if (!found) return
  const rows = found.holdings.map((h) => `<div class="row"><span>${h.symbol}</span><span>${show(h.amount, h.decimals)}</span></div>`)
  if (found.feeBalance > 0n) rows.push(`<div class="row"><span class="muted">Waiting at your drop-off address</span><span>${show(found.feeBalance, 18)} ETH</span></div>`)
  $('holdings').innerHTML = rows.join('') || '<p class="muted">This account has nothing in the vault.</p>'
}

function renderFee() {
  if (!found) return
  const enough = found.feeBalance >= needed()
  $('feeNeeded').textContent = `${show(needed(), 18)} ETH`
  $('feeHave').innerHTML = `<span class="${enough ? 'ok' : ''}">${show(found.feeBalance, 18)} ETH</span>`
  $('feeAddr').textContent = found.feeAddress
  $('feeTopUp').hidden = enough
  const to = $<HTMLInputElement>('to').value.trim()
  $<HTMLButtonElement>('goBtn').disabled = !enough || !isAddress(to) || withdrawals() === 0
}

$('findBtn').onclick = async () => {
  phrase = $<HTMLTextAreaElement>('phrase').value.trim().toLowerCase().replace(/\s+/g, ' ')
  if (phrase.split(' ').length !== 12) return void ($('findNote').innerHTML = '<span class="bad">Enter all 12 words, separated by spaces.</span>')
  const btn = $<HTMLButtonElement>('findBtn')
  btn.disabled = true
  btn.textContent = 'Reading the blockchain…'
  $('findNote').textContent = 'This can take a moment.'
  proofFiles().catch(() => {}) // start loading the proof files now
  try {
    found = await find(phrase, network())
    $('findNote').textContent = 'Found. Your words never leave this device.'
    $('s2').hidden = false
    $('s3').hidden = false
    renderHoldings()
    renderFee()
    // watch the drop-off address for the fee to arrive
    poll ??= setInterval(async () => {
      if (!found) return
      const again = await find(phrase, network()).catch(() => null)
      if (again) {
        found = again
        renderHoldings()
        renderFee()
      }
    }, 8000)
  } catch (e) {
    $('findNote').innerHTML = `<span class="bad">${(e as Error).message.includes('mnemonic') || (e as Error).message.includes('phrase') ? 'Those words are not a valid recovery phrase. Check each word and its order.' : 'Could not read the blockchain. Check your connection, or change the RPC address under Network settings.'}</span>`
  } finally {
    btn.disabled = false
    btn.textContent = 'Find my money'
  }
}

$('to').oninput = renderFee
$('copyFee').onclick = async () => {
  await navigator.clipboard.writeText(found?.feeAddress ?? '').catch(() => {})
  $('copyFee').textContent = 'Copied'
  setTimeout(() => ($('copyFee').textContent = 'Copy address'), 1500)
}

function renderSteps(steps: Step[]) {
  const net = network()
  $('steps').innerHTML = steps
    .map((s) => {
      const state =
        s.state === 'done'
          ? `<span class="ok"><span class="dot"></span>${s.hash ? `<a href="${net.explorer}/tx/${s.hash}" target="_blank" rel="noopener">Sent</a>` : 'Sent'}</span>`
          : s.state === 'working'
            ? '<span><span class="dot working"></span>Sending</span>'
            : s.state === 'failed'
              ? '<span class="bad"><span class="dot"></span>Stopped</span>'
              : '<span class="muted">Waiting</span>'
      return `<div class="row"><span>${s.label}</span>${state}</div>`
    })
    .join('')
}

async function go() {
  if (!found) return
  const to = getAddress($<HTMLInputElement>('to').value.trim()) as Address
  if (poll) clearInterval(poll)
  poll = null
  $('s4').hidden = false
  $<HTMLButtonElement>('goBtn').disabled = true
  $('retryBtn').hidden = true
  $('doneTitle').textContent = 'Sending'
  $('doneNote').textContent = 'Keep this page open. Each withdrawal is proven on this device first.'
  $('s4').scrollIntoView({ behavior: 'smooth' })
  const steps = await rescue(phrase, to, network(), await proofFiles(), renderSteps)
  const failed = steps.find((s) => s.state === 'failed')
  if (failed) {
    $('doneTitle').textContent = 'Paused'
    $('doneNote').innerHTML = `<span class="bad">${failed.error}</span> Everything marked Sent has arrived. Nothing else was spent.`
    $('retryBtn').hidden = false
    return
  }
  // last, whatever ETH is left at the drop-off address
  await sweepDropOff(phrase, to, network()).catch(() => null)
  $('doneTitle').textContent = 'Done'
  $('doneNote').innerHTML = `<span class="ok">Everything has been sent to ${to.slice(0, 6)}…${to.slice(-4)}.</span> It may take a moment to show in your wallet.`
}
$('goBtn').onclick = go
$('retryBtn').onclick = async () => {
  found = await find(phrase, network())
  go()
}
