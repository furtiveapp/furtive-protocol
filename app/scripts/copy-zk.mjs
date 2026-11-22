// Copies the proving files into public/zk so the app can load and cache them.
import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('public/zk', { recursive: true })
copyFileSync('../circuits/build/transact_js/transact.wasm', 'public/zk/transact.wasm')
copyFileSync('../circuits/build/transact_dev.zkey', 'public/zk/transact.zkey')
console.log('proving files copied')
