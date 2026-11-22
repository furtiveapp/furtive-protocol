// Called by the Foundry tests through vm.ffi. Prints ABI-encoded words as hex.
//   node test/ffi/furtive.mjs note <sk> <blinding> <asset> <amount>
//   node test/ffi/furtive.mjs prove <json>
import { commitmentOf, createKeys, createNote, proveTransact } from '../../../sdk/src/index.mjs'

const WASM = '../circuits/build/transact_js/transact.wasm'
const ZKEY = '../circuits/build/transact_dev.zkey'

const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const out = (words) => {
  process.stdout.write('0x' + words.map(word).join(''))
  process.exit(0)
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'note') {
  const [sk, blinding, asset, amount] = args
  const { pk } = await createKeys(BigInt(sk))
  const n = await createNote({ pk, asset, amount, blinding: BigInt(blinding) })
  out([pk, n.npk, n.commitment])
} else if (cmd === 'commit') {
  const [npk, asset, amount] = args
  out([await commitmentOf(BigInt(npk), asset, amount)])
} else if (cmd === 'prove') {
  const j = JSON.parse(args[0])
  const { proof, tx } = await proveTransact({
    wasm: WASM,
    zkey: ZKEY,
    leaves: j.leaves,
    asset: j.asset,
    inputs: j.inputs,
    outputs: j.outputs,
    publicAmount: j.publicAmount,
    extDataHash: j.extDataHash,
  })
  out([...proof.a, ...proof.b[0], ...proof.b[1], ...proof.c, tx.root, tx.treeDepth, ...tx.nullifiers, ...tx.commitments])
} else {
  console.error('unknown command')
  process.exit(1)
}
