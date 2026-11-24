// Types for the plain-JavaScript SDK in ../sdk/src.
declare module '@sdk/core.mjs' {
  export const FIELD: bigint
  export function poseidon(): Promise<(inputs: bigint[]) => bigint>
  export function randomField(): bigint
  export function createNote(o: { pk: bigint; asset: string | bigint; amount: bigint; blinding?: bigint }): Promise<{
    npk: bigint
    blinding: bigint
    asset: bigint
    amount: bigint
    commitment: bigint
  }>
}

declare module '@sdk/index.mjs' {
  export const FIELD: bigint
  export function poseidon(): Promise<(inputs: bigint[]) => bigint>
  export function randomField(): bigint
  export function createNote(o: { pk: bigint; asset: string | bigint; amount: bigint; blinding?: bigint }): Promise<{
    npk: bigint
    blinding: bigint
    asset: bigint
    amount: bigint
    commitment: bigint
  }>
  export function proveTransact(o: unknown): Promise<{ proof: unknown; tx: Record<string, unknown> }>
}

declare module '@sdk/wallet.mjs' {
  export type Account = { sk: bigint; pk: bigint; depositKey: `0x${string}`; viewKey: CryptoKey }
  export function newPhrase(): string
  export function isValidPhrase(p: string): boolean
  export function accountFromPhrase(p: string): Promise<Account>
  export function sealNote(viewKey: CryptoKey, note: { blinding: bigint; amount?: bigint; asset?: bigint }): Promise<`0x${string}`>
  export function decoyNote(): `0x${string}`
}

declare module '@sdk/chain.mjs' {
  export type Leaf = { index: bigint; commitment: bigint; sealed: `0x${string}`; asset?: bigint; amount?: bigint }
  export type OwnedNote = { commitment: bigint; index: bigint; asset: bigint; amount: bigint; blinding: bigint; sk: bigint }
  export function readVault(client: unknown, vault: string, fromBlock: bigint): Promise<{ leaves: Leaf[]; spent: Set<bigint> }>
  export function findNotes(account: unknown, state: { leaves: Leaf[]; spent: Set<bigint> }): Promise<OwnedNote[]>
  export function balances(notes: OwnedNote[]): Map<bigint, bigint>
}

declare module '@sdk/orders.mjs' {
  import type { Account } from '@sdk/wallet.mjs'
  export type OrderTerms = {
    assetOut: `0x${string}`; minOut: bigint; outNpk: bigint; outNoteHash: `0x${string}`; cancelNpk: bigint; cancelNoteHash: `0x${string}`
    cancelKeyHash: `0x${string}`; expiry: bigint; trigger: number; poolId: `0x${string}`; triggerSqrtPrice: bigint; fillerFee: bigint; salt: bigint
  }
  export const TRIGGER: { none: 0; atOrBelow: 1; atOrAbove: 2 }
  export function termsHash(terms: OrderTerms): bigint
  export function openData(viewKey: CryptoKey, hex: `0x${string}`): Promise<unknown | null>
  export function prepareOrder(
    account: Account,
    o: { assetIn: string; amount: bigint; assetOut: string; minOut: bigint; expiry: number; trigger?: number; poolId?: `0x${string}`; triggerSqrtPrice?: bigint; fillerFee?: bigint },
  ): Promise<{ terms: OrderTerms; termsHash: bigint; sealedTerms: `0x${string}`; cancelKey: `0x${string}`; outSealed: `0x${string}`; backSealed: `0x${string}`; adapterData: `0x${string}` }>
}
