// Builds Furtive Rescue as one self-contained page (see tools/pack-rescue.mjs).
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./rescue', import.meta.url)),
  base: './',
  plugins: [nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events', 'os', 'path', 'fs', 'constants'], globals: { Buffer: true, process: true } })],
  resolve: {
    alias: { '@sdk': fileURLToPath(new URL('../sdk/src', import.meta.url)) },
    dedupe: ['snarkjs', 'poseidon-lite', 'viem', '@zk-kit/lean-imt', '@scure/bip39', '@noble/hashes'],
  },
  define: { ZK_WASM: JSON.stringify(''), ZK_ZKEY: JSON.stringify('') },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist-rescue', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: 'rescue.js' } },
  },
})
