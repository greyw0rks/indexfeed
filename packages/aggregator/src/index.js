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
export { SEED_UNIVERSE, UNIVERSE_SYMBOLS, SOURCE_IDS } from "./universe.js";
export { loadConfig, buildSources } from "./config.js";
