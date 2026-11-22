// Proofs are made here, off the main thread, so the app stays smooth while the
// phone works. Nothing secret leaves this device: the worker only returns the proof.
//
// The worker stays alive: it downloads the proof files once, as soon as the app
// opens, and keeps them in memory, so a trade starts proving the instant you tap.
import { proveTransact } from '@sdk/index.mjs'

const files: Record<string, Promise<Uint8Array>> = {}
const load = (url: string) =>
  (files[url] ??= fetch(url)
    .then((r) => {
      if (!r.ok || !r.body) throw new Error('The proof files did not load.')
      // shipped gzipped (36% smaller); unpacked here as they arrive
      return url.endsWith('.gz') ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : r.arrayBuffer()
    })
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      delete files[url]
      throw e
    }))

self.onmessage = async (e: MessageEvent) => {
  const { id, warm, params } = e.data
  try {
    if (warm) {
      await Promise.all(warm.map(load))
      return self.postMessage({ id, ok: true })
    }
    const [wasm, zkey] = await Promise.all([load(params.wasm), load(params.zkey)])
    const result = await proveTransact({ ...params, wasm: { type: 'mem', data: wasm }, zkey: { type: 'mem', data: zkey } })
    self.postMessage({ id, ok: true, result })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
