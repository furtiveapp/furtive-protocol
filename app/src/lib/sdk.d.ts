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
