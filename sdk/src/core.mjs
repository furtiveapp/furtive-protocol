// Furtive SDK core: keys, notes and the note tree. Small enough for the main
// thread; proofs live in index.mjs so their heavy library loads only when needed.
//
// Everything secret is made and kept on the user's device. Nothing in this file
// sends anything anywhere.
import { poseidon1 } from 'poseidon-lite/poseidon1'
import { poseidon2 } from 'poseidon-lite/poseidon2'
import { poseidon3 } from 'poseidon-lite/poseidon3'
import { LeanIMT } from '@zk-kit/lean-imt'

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export const MAX_DEPTH = 32
const MAX_AMOUNT = 2n ** 248n

const HASHES = [null, poseidon1, poseidon2, poseidon3]
const hasher = (inputs) => HASHES[inputs.length](inputs.map(BigInt))
/** Poseidon over the BN254 field, identical to circomlib's and poseidon-solidity's
 *  (checked against circomlibjs in sdk/test). Async for a stable interface. */
export async function poseidon() {
  return hasher
}

/** A uniformly random field element from the platform's secure random source. */
export function randomField() {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n % FIELD
}

export const assetId = (address) => BigInt(address)

/** The owner's keys. sk never leaves the device. */
export async function createKeys(sk = randomField()) {
  const H = await poseidon()
  return { sk, pk: H([sk]) }
}

/** A note for `pk`. Give the result's npk to the vault; keep blinding secret. */
export async function createNote({ pk, asset, amount, blinding = randomField() }) {
  const H = await poseidon()
  amount = BigInt(amount)
  if (amount < 0n || amount >= MAX_AMOUNT) throw new Error('amount out of range')
  const npk = H([pk, blinding])
  return { npk, blinding, asset: assetId(asset), amount, commitment: H([npk, assetId(asset), amount]) }
}

/** The commitment the vault computes for (npk, asset, amount). */
export async function commitmentOf(npk, asset, amount) {
  const H = await poseidon()
  return H([npk, assetId(asset), BigInt(amount)])
}

export async function nullifierOf(sk, commitment) {
  const H = await poseidon()
  return H([sk, commitment])
}

/** The vault's note tree, rebuilt from its leaves in insertion order. */
export async function buildTree(leaves) {
  const H = await poseidon()
  const tree = new LeanIMT((a, b) => H([a, b]))
  for (const leaf of leaves) tree.insert(BigInt(leaf))
  return tree
}

