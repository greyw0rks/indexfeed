/**
 * The candidate universe and its per-source identifiers.
 *
 * Membership here is *candidacy*, not inclusion: the methodology screen decides
 * what actually enters the index each epoch. Fundamentals (free float, volume,
 * listing age) are the inputs the screen reads; in production these come from a
 * data provider, and the values below are the seed snapshot used for Phase 1.
 */

/** Ticker -> id at each source. A missing id means that source skips the asset. */
export const SOURCE_IDS = {
  coingecko: {
    XLM: "stellar",
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    XRP: "ripple",
    ADA: "cardano",
    AVAX: "avalanche-2",
    DOT: "polkadot",
    LINK: "chainlink",
    UNI: "uniswap",
  },
  // Paprika ids, not tickers — several assets share a ticker and matching on
  // symbol would price a wrapped derivative as the real asset.
  coinpaprika: {
    XLM: "xlm-stellar",
    BTC: "btc-bitcoin",
    ETH: "eth-ethereum",
    SOL: "sol-solana",
    XRP: "xrp-xrp",
    ADA: "ada-cardano",
    AVAX: "avax-avalanche",
    DOT: "dot-polkadot",
    LINK: "link-chainlink",
    UNI: "uni-uniswap",
  },
  bitstamp: {
    XLM: "xlmusd",
    BTC: "btcusd",
    ETH: "ethusd",
    SOL: "solusd",
    XRP: "xrpusd",
    ADA: "adausd",
    AVAX: "avaxusd",
    DOT: "dotusd",
    LINK: "linkusd",
    UNI: "uniusd",
  },
  // Bitfinex v2 symbols. Tickers longer than three characters take the
  // colon-separated form.
  bitfinex: {
    XLM: "tXLMUSD",
    BTC: "tBTCUSD",
    ETH: "tETHUSD",
    SOL: "tSOLUSD",
    XRP: "tXRPUSD",
    ADA: "tADAUSD",
    AVAX: "tAVAX:USD",
    DOT: "tDOTUSD",
    LINK: "tLINK:USD",
    UNI: "tUNIUSD",
  },
};

/**
 * Seed fundamentals snapshot. Replace with a live provider feed in Phase 2 —
 * these numbers decide eligibility, so a stale snapshot means a stale index.
 */
export const SEED_UNIVERSE = [
  { symbol: "BTC", freeFloatMarketCapUsd: 1_200_000_000_000, avgDailyVolumeUsd: 20_000_000_000, listingAgeDays: 5_600 },
  { symbol: "ETH", freeFloatMarketCapUsd: 380_000_000_000, avgDailyVolumeUsd: 12_000_000_000, listingAgeDays: 3_700 },
  { symbol: "XRP", freeFloatMarketCapUsd: 110_000_000_000, avgDailyVolumeUsd: 3_000_000_000, listingAgeDays: 4_400 },
  { symbol: "SOL", freeFloatMarketCapUsd: 80_000_000_000, avgDailyVolumeUsd: 3_500_000_000, listingAgeDays: 2_000 },
  { symbol: "ADA", freeFloatMarketCapUsd: 25_000_000_000, avgDailyVolumeUsd: 700_000_000, listingAgeDays: 3_100 },
  { symbol: "AVAX", freeFloatMarketCapUsd: 14_000_000_000, avgDailyVolumeUsd: 500_000_000, listingAgeDays: 1_800 },
  { symbol: "LINK", freeFloatMarketCapUsd: 12_000_000_000, avgDailyVolumeUsd: 600_000_000, listingAgeDays: 2_600 },
  { symbol: "XLM", freeFloatMarketCapUsd: 11_000_000_000, avgDailyVolumeUsd: 300_000_000, listingAgeDays: 4_100 },
  { symbol: "DOT", freeFloatMarketCapUsd: 9_000_000_000, avgDailyVolumeUsd: 250_000_000, listingAgeDays: 1_900 },
  { symbol: "UNI", freeFloatMarketCapUsd: 7_000_000_000, avgDailyVolumeUsd: 200_000_000, listingAgeDays: 1_800 },
];

export const UNIVERSE_SYMBOLS = SEED_UNIVERSE.map((a) => a.symbol);
