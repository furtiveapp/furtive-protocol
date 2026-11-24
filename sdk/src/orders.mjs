// Private limit orders and stop-losses: everything the owner's phone prepares when
// placing one, and what it needs later to recognise, cancel or recover it.
//
// The vault stores only keccak256(abi.encode(terms)). The terms themselves go
// (a) to whoever fills orders (the Furtive order-watcher), and (b) on chain, sealed
// with the owner's view key, so 12 words alone can always find and cancel an order.
import { encodeAbiParameters, keccak256, toHex } from 'viem'
import { createNote, randomField } from './core.mjs'
import { sealNote } from './wallet.mjs'

export const ORDER_TERMS_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'assetOut', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'outNpk', type: 'uint256' },
      { name: 'outNoteHash', type: 'bytes32' },
      { name: 'cancelNpk', type: 'uint256' },
      { name: 'cancelNoteHash', type: 'bytes32' },
      { name: 'cancelKeyHash', type: 'bytes32' },
      { name: 'expiry', type: 'uint64' },
      { name: 'trigger', type: 'uint8' },
      { name: 'poolId', type: 'bytes32' },
      { name: 'triggerSqrtPrice', type: 'uint160' },
      { name: 'fillerFee', type: 'uint256' },
      { name: 'salt', type: 'uint256' },
    ],
  },
]

export const TRIGGER = { none: 0, atOrBelow: 1, atOrAbove: 2 }

const rand32 = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))

/** The fingerprint the vault stores: keccak256(abi.encode(terms)), as a number. */
export const termsHash = (terms) => BigInt(keccak256(encodeAbiParameters(ORDER_TERMS_ABI, [terms])))

/** AES-GCM with the view key, for any small payload (the order's recovery record). */
export async function sealData(viewKey, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const body = new TextEncoder().encode(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)))
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, viewKey, body))
  const all = new Uint8Array(12 + ct.length)
  all.set(iv); all.set(ct, 12)
  return toHex(all)
}

export async function openData(viewKey, hex) {
  try {
    const b = Uint8Array.from(hex.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16))
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, viewKey, b.slice(12))
    return JSON.parse(new TextDecoder().decode(pt), (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v))
  } catch {
    return null
  }
}

/**
 * Prepares an order. `amount` of `assetIn` will leave the private balance into the
 * order; if it fills, at least `minOut` of `assetOut` comes back as a note only this
 * account can open. Optional trigger: only fill while the pool price is at or
 * below (stop on a buy, limit on a sell) or at or above `triggerSqrtPrice`.
 */
export async function prepareOrder(account, { assetIn, amount, assetOut, minOut, expiry, trigger = TRIGGER.none, poolId = `0x${'0'.repeat(64)}`, triggerSqrtPrice = 0n, fillerFee = 0n }) {
  // the proceeds note: its amount is set by the vault from what the swap returns
  const out = await createNote({ pk: account.pk, asset: assetOut, amount: 0n })
  const outSealed = await sealNote(account.viewKey, { blinding: out.blinding, amount: 0n, asset: BigInt(assetOut) })
  // the cancel note: the same amount coming back if the order is cancelled
  const back = await createNote({ pk: account.pk, asset: assetIn, amount })
  const backSealed = await sealNote(account.viewKey, back)
  const cancelKey = rand32()
  const terms = {
    assetOut,
    minOut,
    outNpk: out.npk,
    outNoteHash: keccak256(outSealed),
    cancelNpk: back.npk,
    cancelNoteHash: keccak256(backSealed),
    cancelKeyHash: keccak256(encodeAbiParameters([{ type: 'bytes32' }], [cancelKey])),
    expiry: BigInt(expiry),
    trigger,
    poolId,
    triggerSqrtPrice: BigInt(triggerSqrtPrice),
    fillerFee: BigInt(fillerFee),
    salt: randomField(),
  }
  const hash = termsHash(terms)
  // everything 12 words need to recognise and cancel it later
  const sealedTerms = await sealData(account.viewKey, { v: 1, assetIn, amount, terms, cancelKey, outSealed, backSealed })
  return { terms, termsHash: hash, sealedTerms, cancelKey, outSealed, backSealed, adapterData: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [hash, sealedTerms]) }
}
