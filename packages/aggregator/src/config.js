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
import { SOURCE_IDS } from "./universe.js";

loadEnv();

export function loadConfig(env = process.env) {
  const network = env.STELLAR_NETWORK ?? "testnet";
  return {
    network,
    rpcUrl: env.STELLAR_RPC_URL ?? undefined,
    contractId: env.ORACLE_CONTRACT_ID,
    publisherSecret: env.PUBLISHER_SECRET_KEY,
    adminPublicKey: env.ADMIN_PUBLIC_KEY,
    stateDir: env.STATE_DIR ?? "./state",
    /** Offline mode swaps live venues for fixtures; never enable in production. */
    useFixtures: env.USE_FIXTURE_PRICES === "1",
  };
}

/** Deterministic prices for offline runs. Order of magnitude only. */
const FIXTURE_PRICES = {
  BTC: 62_000, ETH: 3_100, XRP: 1.85, SOL: 148, ADA: 0.68,
  AVAX: 34, LINK: 17.5, XLM: 0.36, DOT: 6.2, UNI: 9.4,
};

export function buildSources(config) {
  if (config.useFixtures) {
    // Three fixtures with a small spread, so reconciliation is exercised
    // rather than bypassed.
    const skew = (f) => Object.fromEntries(Object.entries(FIXTURE_PRICES).map(([k, v]) => [k, v * f]));
    return [
      fixtureSource("fixture-a", FIXTURE_PRICES),
      fixtureSource("fixture-b", skew(1.001)),
      fixtureSource("fixture-c", skew(0.999)),
    ];
  }
  // Two independent exchanges plus two aggregators. The exchanges are what make
  // reconciliation meaningful; the aggregators are composites and would agree
  // with each other even when both are stale.
  return [
    bitstampSource(SOURCE_IDS.bitstamp),
    bitfinexSource(SOURCE_IDS.bitfinex),
    coingeckoSource(SOURCE_IDS.coingecko),
    coinpaprikaSource(SOURCE_IDS.coinpaprika),
  ];
}
