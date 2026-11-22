# Credits

Furtive's privacy protocol is our own design, built on open work by others. Thank you to everyone below.

| Work | Authors | Licence | Used for |
|---|---|---|---|
| [circom](https://github.com/iden3/circom), [circomlib](https://github.com/iden3/circomlib) | iden3 / 0KIMS association | GPL-3.0 | Writing the circuit; Poseidon hash, comparators and bit checks inside it |
| [snarkjs](https://github.com/iden3/snarkjs), [ffjavascript](https://github.com/iden3/ffjavascript) | iden3 / 0KIMS association | GPL-3.0 | Making Groth16 proofs on the phone; generating `TransactVerifier.sol` |
| [Privacy Pools](https://github.com/0xbow-io/privacy-pools-core) | 0xbow | Apache-2.0 | The LeanIMT inclusion circuit in `circuits/lib/merkleTree.circom` (adapted: include paths) |
| [LeanIMT](https://github.com/privacy-scaling-explorations/zk-kit) (Solidity and JS) | Ethereum Foundation, Privacy & Scaling Explorations | MIT | The vault's note tree (`contracts/lib/lean-imt`) and the SDK's tree |
| [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) | Ethereum Foundation PSE and its contributors | Public | Phase 1 of the trusted setup (`ppot_0080_16.ptau`) |
| [poseidon-solidity](https://github.com/chancehudson/poseidon-solidity) | Chance Hudson | MIT | Poseidon hashing in the vault, via the canonical deployed libraries |
| [poseidon-lite](https://github.com/vimwitch/poseidon-lite) | Chance Hudson | MIT | Poseidon hashing in the app |
| [viem](https://github.com/wevm/viem) | wevm | MIT | Talking to the blockchain |
| [@scure/bip39](https://github.com/paulmillr/scure-bip39), [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Paul Miller | MIT | Recovery phrases and hashing |
| [Uniswap v4](https://github.com/Uniswap/v4-core) | Uniswap Labs | — | The pools trades route through. Called on-chain; no code copied |
| [Foundry](https://github.com/foundry-rs/foundry) | Foundry contributors | MIT / Apache-2.0 | Building and testing the contracts |

The development proving key in this repository comes from a single-contributor phase 2 and is for testnet only. Mainnet will use a public phase 2 ceremony.
