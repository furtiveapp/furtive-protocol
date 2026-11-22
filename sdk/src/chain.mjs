// Reading the vault: every note in order, and which of them belong to the user.
import { parseAbiItem, parseEventLogs } from 'viem'
import { poseidon } from './core.mjs'
import { openNote } from './wallet.mjs'

const EVENTS = {
  deposited: parseAbiItem('event Deposited(address indexed asset, uint256 amount, uint256 commitment, uint256 leafIndex, bytes encryptedNote)'),
  created: parseAbiItem('event NoteCreated(uint256 commitment, uint256 leafIndex, bytes encryptedNote)'),
  swapped: parseAbiItem(
    'event Swapped(address indexed assetIn, address indexed assetOut, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 commitment, uint256 leafIndex, bytes encryptedNote)',
  ),
  spent: parseAbiItem('event NoteSpent(uint256 nullifier)'),
}

/**
 * Every leaf in the vault in insertion order, plus every spent nullifier.
 * Reads in windows so it works on RPCs that cap log ranges.
 */
export async function readVault(client, vault, fromBlock, { step = 5_000_000n, retries = 10 } = {}) {
  // The vault's own leaf count is the truth. Some RPCs serve logs a moment after
  // the receipt, so read again until every leaf up to that count is present.
  const size = await client.readContract({ address: vault, abi: TREE_SIZE, functionName: 'treeSize' })
  let last = 'the network did not answer'
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await readLogs(client, vault, fromBlock, step)
      const complete = BigInt(r.leaves.length) >= size && r.leaves.every((l, i) => l.index === BigInt(i))
      if (complete) return r
      last = `the network returned ${r.leaves.length} of ${size} notes`
    } catch (e) {
      // a load-balanced RPC can briefly reject a range its node has not reached yet
      last = e?.shortMessage || e?.message || last
    }
    await new Promise((ok) => setTimeout(ok, 800))
  }
  throw new Error(`Could not read your balance (${last}). Pull to refresh in a moment.`)
}

const TREE_SIZE = [parseAbiItem('function treeSize() view returns (uint256)')]

async function readLogs(client, vault, fromBlock, step) {
  const latest = await client.getBlockNumber()
  const leaves = []
  const spent = new Set()
  for (let start = BigInt(fromBlock); start <= latest; start += step) {
    // the last window ends at 'latest' so it never names a block a lagging node lacks
    const end = start + step - 1n >= latest ? 'latest' : start + step - 1n
    // Filter by address only and decode here: RPCs allow far wider ranges for that
    // (10M blocks on Robinhood Chain) than for multi-event topic filters (100k).
    const raw = await client.getLogs({ address: vault, fromBlock: start, toBlock: end })
    const logs = parseEventLogs({ abi: Object.values(EVENTS), logs: raw, strict: false })
    for (const l of logs) {
      const a = l.args
      if (l.eventName === 'NoteSpent') spent.add(a.nullifier)
      else if (l.eventName === 'Deposited') leaves.push({ index: a.leafIndex, commitment: a.commitment, sealed: a.encryptedNote, asset: BigInt(a.asset), amount: a.amount })
      else if (l.eventName === 'NoteCreated') leaves.push({ index: a.leafIndex, commitment: a.commitment, sealed: a.encryptedNote })
      else if (l.eventName === 'Swapped') leaves.push({ index: a.leafIndex, commitment: a.commitment, sealed: a.encryptedNote, asset: BigInt(a.assetOut), amount: a.amountOut })
    }
  }
  leaves.sort((x, y) => (x.index < y.index ? -1 : 1))
  return { leaves, spent }
}

/**
 * The user's unspent notes. A note counts only when its backup opens with the
 * user's view key AND the opened values rebuild exactly the commitment in the
 * tree, so a forged or garbled backup can never show up as money.
 */
export async function findNotes(account, { leaves, spent }) {
  const H = await poseidon()
  const notes = []
  for (const leaf of leaves) {
    const opened = await openNote(account.viewKey, leaf.sealed)
    if (!opened) continue
    // amounts and assets the chain states win over the backup's copy
    const amount = leaf.amount ?? opened.amount
    const asset = leaf.asset ?? opened.asset
    if (amount === 0n) continue
    const npk = H([account.pk, opened.blinding])
    if (H([npk, asset, amount]) !== leaf.commitment) continue
    const nullifier = H([account.sk, leaf.commitment])
    if (spent.has(nullifier)) continue
    notes.push({ commitment: leaf.commitment, index: leaf.index, asset, amount, blinding: opened.blinding, sk: account.sk })
  }
  return notes
}

/** Balance per asset from a list of notes. */
export function balances(notes) {
  const out = new Map()
  for (const n of notes) out.set(n.asset, (out.get(n.asset) ?? 0n) + n.amount)
  return out
}
