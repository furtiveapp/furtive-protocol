# Furtive protocol

Private, non-custodial trading on Robinhood Chain. This repository holds everything that touches your money: the zero-knowledge circuit, the vault contracts, the SDK and the app that makes proofs on your phone.

**Live on testnet:** [furtive.app](https://furtive.app) · app [app.furtive.app](https://app.furtive.app) · bot [@BeFurtiveBot](https://t.me/BeFurtiveBot)

## How it works

Everyone's money sits in one shared vault as private notes. To trade or withdraw, your phone makes a Groth16 proof that you own notes in the vault, without revealing which ones. The vault checks the proof and acts. Nobody on the chain can tell which trade was yours.

- **No owner.** The vault has no admin, no upgrade path and no pause. Anyone may submit a transaction; only a valid proof decides what happens.
- **Your keys stay on your phone.** They come from your 12 words and never leave the device.
- **Always withdrawable.** [Furtive Rescue](https://github.com/furtiveapp/furtive-rescue) takes everything out with only your 12 words, without Furtive's servers.

## What is here

| Folder | Contents |
|---|---|
| `circuits/` | `transact.circom`: two notes in, two notes out, one public amount (about 19k constraints). Build scripts and the testnet keys. |
| `contracts/` | `FurtiveVault.sol`, the Uniswap v4 swap adapter, the quoter, the generated verifier, tests (including real proofs) and deploy scripts. |
| `sdk/` | Keys from 12 words, notes, the tree, proofs and chain reading. Shared by the app and the rescue tool. |
| `app/` | The Telegram mini-app, including `app/rescue`, the source of Furtive Rescue. |

## Testnet (Robinhood Chain, 46630)

| Contract | Address |
|---|---|
| FurtiveVault | `0x4136881594De8661b0d4F005AdAFbce67F2FD018` |
| Verifier | `0x834FD041872F0A578cf263A5Af325df01A89939E` |
| Uniswap v4 adapter | `0xAE13eC8f44F7201764Ba411d716B323DE1174aEe` |
| Quoter | `0x520B8fC1a687eeD97Ad4015c4242A2111d8332aE` |

## Build

```
cd circuits && npm install && node scripts/build.mjs
cd contracts && forge install foundry-rs/forge-std && forge test
cd app && npm install && npx vite build
```

## Licence and credits

GPL-3.0. Built on circom, snarkjs, Privacy Pools, LeanIMT and more: see [CREDITS.md](CREDITS.md).

Security issues: hello@furtive.app with "Security" in the subject.
