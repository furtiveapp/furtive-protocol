// A Furtive account: one 12-word recovery phrase, everything else derived from it.
//
//   spend key    proves ownership of notes; never leaves the device
//   view key     decrypts the user's own note backups stored on chain
//   deposit key  an ordinary wallet the user funds from anywhere, which then
//                moves those funds into the vault
//
// The phrase is the only thing to back up. With it, every note can be found
// and spent again on any device.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils'
import { FIELD, poseidon } from './core.mjs'

const derive = (label, seed) => sha256(concatBytes(utf8ToBytes(`furtive/${label}`), seed))
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const newPhrase = () => generateMnemonic(wordlist, 128)
export const isValidPhrase = (phrase) => validateMnemonic(phrase.trim().toLowerCase().replace(/\s+/g, ' '), wordlist)

/** Every key of an account, from its phrase. */
export async function accountFromPhrase(phrase) {
  const clean = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!validateMnemonic(clean, wordlist)) throw new Error('That recovery phrase is not valid.')
  const seed = mnemonicToSeedSync(clean)

  const sk = BigInt('0x' + bytesToHex(derive('spend', seed))) % FIELD
  const H = await poseidon()
  const pk = H([sk])

  let d = BigInt('0x' + bytesToHex(derive('deposit', seed)))
  d = (d % (SECP_N - 1n)) + 1n
  const depositKey = '0x' + d.toString(16).padStart(64, '0')

  const viewKey = await globalThis.crypto.subtle.importKey('raw', derive('view', seed), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { sk, pk, depositKey, viewKey }
}

// ───────────────────────────────────────────── encrypted note backups

// Layout before encryption, always 85 bytes:
//   [0]      version (1)
//   [1..33)  blinding
//   [33..65) amount (0 when the chain states it, as for swap proceeds)
//   [65..85) asset  (0 is native ETH; the chain's value wins when it states one)
const PAYLOAD = 85 // every backup has the same size, so they all look alike
const SEALED = 12 + PAYLOAD + 16

const toBytes = (n, len) => {
  const out = new Uint8Array(len)
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}
const toBig = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n)

/** Seal a note's secrets for its owner. Only the owner's view key opens it. */
export async function sealNote(viewKey, note) {
  const body = new Uint8Array(PAYLOAD)
  body[0] = 1
  body.set(toBytes(BigInt(note.blinding), 32), 1)
  body.set(toBytes(BigInt(note.amount ?? 0n), 32), 33)
  body.set(toBytes(BigInt(note.asset ?? 0n), 20), 65)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, viewKey, body))
  return '0x' + bytesToHex(concatBytes(iv, ct))
}

/** Random bytes the size of a sealed note, for outputs that carry nothing. */
export function decoyNote() {
  return '0x' + bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(SEALED)))
}

/** Opens a backup if it is ours; returns null otherwise. */
export async function openNote(viewKey, sealedHex) {
  try {
    const bytes = Uint8Array.from(sealedHex.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16))
    if (bytes.length !== SEALED) return null
    const pt = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, viewKey, bytes.slice(12)))
    if (pt[0] !== 1) return null
    // asset 0 is native ETH, a real value; amount 0 means the chain states it (swap proceeds)
    return { blinding: toBig(pt.slice(1, 33)), amount: toBig(pt.slice(33, 65)), asset: toBig(pt.slice(65, 85)) }
  } catch {
    return null
  }
}
