/**
 * Configuration, loaded from the environment.
 *
 * Nothing here has a production-safe default: an unset network or missing RPC
 * URL should fail loudly at startup rather than silently pointing a mainnet
 * publisher at testnet.
 */
import { loadEnv } from "./env.js";
import {
  bitfinexSource,
  bitstampSource,
  coingeckoSource,
  coinpaprikaSource,
  fixtureSource,
} from "./sources.js";
import {
  coingeckoFundamentals,
  coinpaprikaFundamentals,
  fixtureFundamentals,
} from "./fundamentals.js";
import { METHODOLOGY } from "./methodology.js";
import { FIXTURE_UNIVERSE } from "./fixtures.js";

loadEnv();

export function loadConfig(env = process.env) {
  const network = env.STELLAR_NETWORK ?? "testnet";
  /**
   * Offline mode swaps live providers and venues for fixtures; never enable in
   * production. It exists so the pipeline is runnable and testable without
   * network access.
   */
  const useFixtures = env.USE_FIXTURE_PRICES === "1";
  const stateDir = env.STATE_DIR ?? "./state";

  return {
    network,
    rpcUrl: env.STELLAR_RPC_URL ?? undefined,
    contractId: env.ORACLE_CONTRACT_ID,
    publisherSecret: env.PUBLISHER_SECRET_KEY,
    adminPublicKey: env.ADMIN_PUBLIC_KEY,
    /**
     * Fixture runs get their own state directory. Sharing one would let a
     * fixture-computed divisor become the continuity basis for a real epoch,
     * which would corrupt the published index — and conversely a fixture run
     * would fail trying to price real constituents it has no data for.
     */
    stateDir: useFixtures ? `${stateDir}/fixtures` : stateDir,
    useFixtures,
    universeSize: Number(env.UNIVERSE_SIZE ?? METHODOLOGY.fundamentals.universeSize),
  };
}

/**
 * Fundamentals providers — these determine what the index *contains*.
 *
 * CoinGecko is capped at 100 per page by the free tier, so a larger universe
 * costs extra requests; CoinPaprika returns ~2000 in one call and is trimmed
 * client-side.
 */
export function buildFundamentalsProviders(config) {
  if (config.useFixtures) {
    return [fixtureFundamentals("fixture-provider", FIXTURE_UNIVERSE)];
  }
  return [
    coingeckoFundamentals({ pages: Math.ceil(config.universeSize / 100), perPage: 100 }),
    coinpaprikaFundamentals({ limit: config.universeSize }),
  ];
}

/**
 * Price sources — these determine what the index is *worth*.
 *
 * Returned as a function of the symbol resolver rather than a plain array: the
 * aggregator adapters need each provider's opaque slug for an asset, which is
 * only known after fundamentals have been fetched.
 */
export function buildSources(config) {
  if (config.useFixtures) {
    // Three fixtures with a small spread, so reconciliation is exercised
    // rather than bypassed.
    const prices = Object.fromEntries(FIXTURE_UNIVERSE.map((a) => [a.symbol, a.priceUsd]));
    const skew = (f) => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v * f]));
    return () => [
      fixtureSource("fixture-a", prices),
      fixtureSource("fixture-b", skew(1.001)),
      fixtureSource("fixture-c", skew(0.999)),
    ];
  }

  // Two independent exchanges plus two aggregators. The exchanges are what make
  // reconciliation meaningful; the aggregators are composites and would agree
  // with each other even when both are stale.
  return (resolver) => [
    bitstampSource(),
    bitfinexSource(),
    coingeckoSource(resolver),
    coinpaprikaSource(resolver),
  ];
}
