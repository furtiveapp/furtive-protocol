import { defineChain } from 'viem'

// Robinhood Chain testnet. Mainnet values go here at launch.
export const CHAIN = defineChain({
  id: 46630,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
})

export const VAULT = '0x75843C1a45D75F3a1768DbBD191DC7939E3731f5' as const
export const VAULT_FROM_BLOCK = 157178232n
export const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'http://127.0.0.1:8787'
export const ETH = '0x0000000000000000000000000000000000000000' as const
export const ADAPTER = '0x9A14Df1Ab1137954b2913C54D60bF740a95A7E89' as const
export const QUOTER = '0x520B8fC1a687eeD97Ad4015c4242A2111d8332aE' as const
export const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const

/** Tokens the app suggests. Anything else can be found by pasting its address. */
export type Listed = { address: string; symbol: string; name: string; tiers: [number, number][]; stock?: boolean; image?: string; decimals?: number }
export const LISTED: Listed[] = [
  { address: '0xAe3917FD6bF7cf6dD378cd4ba3110BeEd841959f', symbol: 'PEEK', name: 'Peek Test Coin', tiers: [[3000, 60]] },
  // Robinhood Stock Tokens from the testnet faucet, in pools Furtive opened at real mainnet prices.
  { address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', symbol: 'TSLA', name: 'Tesla', tiers: [[2900, 60]], stock: true, image: 'https://coin-images.coingecko.com/coins/images/102174112/large/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png' },
  { address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', symbol: 'AMZN', name: 'Amazon', tiers: [[2900, 60]], stock: true, image: 'https://coin-images.coingecko.com/coins/images/102174126/large/0x12f190a9f9d7d37a250758b26824b97ce941bf54.png' },
  { address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', symbol: 'PLTR', name: 'Palantir', tiers: [[2900, 60]], stock: true, image: 'https://coin-images.coingecko.com/coins/images/102174117/large/0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a.png' },
  { address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', symbol: 'NFLX', name: 'Netflix', tiers: [[2800, 60]], stock: true, image: 'https://coin-images.coingecko.com/coins/images/102174165/large/0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8.png' },
  { address: '0x71178BAc73cBeb415514eB542a8995b82669778d', symbol: 'AMD', name: 'AMD', tiers: [[2900, 60]], stock: true, image: 'https://coin-images.coingecko.com/coins/images/102174114/large/0x86923f96303d656e4aa86d9d42d1e57ad2023fdc.png' },
]

/** Kept in the deposit wallet so it can always pay for its own deposit. */
export const GAS_RESERVE = 20_000_000_000_000n // 0.00002 ETH

// Compressed, and named by their contents so phones can keep them forever.
export const ZK = { wasm: '/zk/transact-5e39c4a14d.wasm.gz', zkey: '/zk/transact-b7e7291c1d.zkey.gz' }
export const explorerTx = (hash: string) => `${CHAIN.blockExplorers.default.url}/tx/${hash}`
