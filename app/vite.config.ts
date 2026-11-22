import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'node:url'

import { cloudflare } from "@cloudflare/vite-plugin";

const nodeLibs = () => nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events', 'os', 'path', 'fs', 'constants'], globals: { Buffer: true, process: true } })

export default defineConfig({
  // Node shims only where snarkjs runs (the proof worker); the main screen needs none.
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@sdk': fileURLToPath(new URL('../sdk/src', import.meta.url)),
    },
    dedupe: ['snarkjs', 'circomlibjs', 'poseidon-lite', 'viem', '@zk-kit/lean-imt', '@scure/bip39', '@noble/hashes'],
  },
  worker: { format: 'es', plugins: () => [nodeLibs()] },
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})