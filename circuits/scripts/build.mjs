// Development keys for the transaction circuit.
//
// These keys are for local tests and testnet only. They come from a single
// development contribution, so whoever ran this script could forge proofs.
// Mainnet keys come from a public multi-party ceremony instead, and the vault
// is deployed with the verifier that ceremony produces.
//
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'

const run = (...args) => execFileSync(process.execPath, ['node_modules/snarkjs/build/cli.cjs', ...args], { stdio: 'inherit' })

const R1CS = 'build/transact.r1cs'
const PTAU = 'ptau/ppot_0080_16.ptau'
if (!existsSync(R1CS)) throw new Error('compile first: circom src/transact.circom --O2 --r1cs --wasm --sym -o build')

run('groth16', 'setup', R1CS, PTAU, 'build/transact_0000.zkey')
run('zkey', 'contribute', 'build/transact_0000.zkey', 'build/transact_dev.zkey', '--name=furtive-dev', `-e=${randomBytes(32).toString('hex')}`)
run('zkey', 'export', 'verificationkey', 'build/transact_dev.zkey', 'build/transact_vkey.json')
run('zkey', 'export', 'solidityverifier', 'build/transact_dev.zkey', 'build/TransactVerifier.sol')
copyFileSync('build/TransactVerifier.sol', '../contracts/src/verifiers/TransactVerifier.sol')
console.log('dev keys ready; verifier copied to contracts/src/verifiers')
