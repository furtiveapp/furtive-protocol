// Furtive SDK: everything in core.mjs, plus transaction proofs.
import * as snarkjs from 'snarkjs'
import { poseidon, assetId, randomField, buildTree, MAX_DEPTH } from './core.mjs'

export * from './core.mjs'

/**
 * Prove a transaction: spend up to two notes of `asset`, make up to two new
 * notes of it, and release `publicAmount` from the vault.
 *
 * @param o.leaves     every leaf in the vault, in order
 * @param o.inputs     notes to spend: { sk, blinding, amount, commitment }
 * @param o.outputs    notes to make:  { npk, amount }
 * @param o.extDataHash the vault's extDataHash(ext) for this transaction
 */
export async function proveTransact({ wasm, zkey, leaves, asset, inputs = [], outputs = [], publicAmount = 0n, extDataHash }) {
  if (inputs.length > 2 || outputs.length > 2) throw new Error('at most two inputs and two outputs')
  const H = await poseidon()
  const a = assetId(asset)
  publicAmount = BigInt(publicAmount)

  const ins = inputs.map((n) => ({ ...n, amount: BigInt(n.amount) }))
  while (ins.length < 2) {
    // a dummy: zero amount, fresh secret so its nullifier is unique
    const sk = randomField(), blinding = randomField()
    const npk = H([H([sk]), blinding])
    ins.push({ sk, blinding, amount: 0n, commitment: H([npk, a, 0n]), dummy: true })
  }
  const outs = outputs.map((n) => ({ npk: BigInt(n.npk), amount: BigInt(n.amount) }))
  while (outs.length < 2) outs.push({ npk: randomField(), amount: 0n })

  const sumIn = ins.reduce((s, n) => s + n.amount, 0n)
  const sumOut = outs.reduce((s, n) => s + n.amount, 0n)
  if (sumIn !== sumOut + publicAmount) throw new Error('inputs must equal outputs plus publicAmount')

  const tree = await buildTree(leaves)
  const root = tree.root
  const depth = BigInt(tree.depth)

  const leafIndex = [], siblings = []
  for (const n of ins) {
    if (n.dummy || n.amount === 0n) {
      leafIndex.push(0n)
      siblings.push(Array(MAX_DEPTH).fill(0n))
      continue
    }
    const idx = tree.indexOf(BigInt(n.commitment))
    if (idx < 0) throw new Error('note not in tree')
    const p = tree.generateProof(idx)
    // zk-kit reports NaN when the path is empty (a tree of one leaf)
    leafIndex.push(BigInt(Number.isNaN(p.index) ? 0 : p.index))
    siblings.push([...p.siblings.map(BigInt), ...Array(MAX_DEPTH - p.siblings.length).fill(0n)])
  }

  const nullifiers = ins.map((n) => H([n.sk, n.commitment]))
  const commitments = outs.map((n) => H([n.npk, a, n.amount]))

  const input = {
    root, treeDepth: depth, asset: a, publicAmount, extDataHash: BigInt(extDataHash),
    inNullifier: nullifiers, outCommitment: commitments,
    inAmount: ins.map((n) => n.amount), inSk: ins.map((n) => n.sk), inBlinding: ins.map((n) => n.blinding),
    inLeafIndex: leafIndex, inSiblings: siblings,
    outAmount: outs.map((n) => n.amount), outNpk: outs.map((n) => n.npk),
  }
  const { proof } = await snarkjs.groth16.fullProve(input, wasm, zkey)
  return {
    proof: {
      a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      b: [[BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]],
      c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    },
    tx: { root, treeDepth: depth, asset, publicAmount, nullifiers, commitments },
  }
}
