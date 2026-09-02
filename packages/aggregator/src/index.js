/** Public surface of the aggregator, re-exported for the API and tests. */
export { METHODOLOGY, methodologyHash, VALUE_DECIMALS, VALUE_SCALE, TOTAL_WEIGHT_BPS } from "./methodology.js";
export { reconcile, reconcileAll, RejectReason } from "./prices.js";
export { screen, weight, toBasisPoints } from "./weighting.js";
export {
  inceptionDivisor,
  rebalanceDivisor,
  level,
  toScaledValue,
  fromScaledValue,
  unitsForWeights,
} from "./index-math.js";
export { runRebalance } from "./rebalance.js";
export { createPublisher, createReader, resolveNetwork, NETWORKS } from "./publisher.js";
export { stateStore } from "./state.js";
export {
  collectQuotes,
  fixtureSource,
  coingeckoSource,
  coinpaprikaSource,
  bitstampSource,
  bitfinexSource,
} from "./sources.js";
export {
  collectFundamentals,
  coingeckoFundamentals,
  coinpaprikaFundamentals,
  fixtureFundamentals,
} from "./fundamentals.js";
export {
  classifyExclusion,
  looksLikeStablecoin,
  looksLikeDerivative,
  ExclusionReason,
  STABLE_MAX_CHANGE_PCT,
} from "./classify.js";
export { createSymbolResolver, bitstampPair, bitfinexPair } from "./symbols.js";
export { FIXTURE_UNIVERSE } from "./fixtures.js";
export { loadConfig, buildSources, buildFundamentalsProviders } from "./config.js";
