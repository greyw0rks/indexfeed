/**
 * The rebalance pipeline: sources -> reconcile -> screen -> weight -> level.
 *
 * `runRebalance` is pure with respect to the chain — it computes an update and
 * returns it along with an audit record. Publishing is a separate step so a dry
 * run is exactly the same computation minus the transaction.
 */
import { METHODOLOGY, methodologyHash } from "./methodology.js";
import { collectQuotes } from "./sources.js";
import { reconcileAll } from "./prices.js";
import { screen, weight, toBasisPoints } from "./weighting.js";
import {
  inceptionDivisor,
  rebalanceDivisor,
  level,
  toScaledValue,
  unitsForWeights,
  fromScaledValue,
} from "./index-math.js";

/** Notional used to express the basket in units. Cancels out of the level. */
const BASKET_NOTIONAL_USD = 1_000_000;

/**
 * Compute the next epoch.
 *
 * @param {object} params
 * @param {Array} params.sources price source adapters
 * @param {Array} params.universe candidate assets with fundamentals
 * @param {object|null} params.previousState `{epoch, basket, divisor}` from the
 *   last epoch, or null at inception
 * @returns {Promise<{update: object, state: object, audit: object}>}
 */
export async function runRebalance({
  sources,
  universe,
  previousState = null,
  methodology = METHODOLOGY,
}) {
  const symbols = universe.map((a) => a.symbol);
  const { quotesBySymbol, sourceErrors } = await collectQuotes(sources, symbols);
  const { prices, rejected } = reconcileAll(quotesBySymbol, methodology);

  // An asset without a consensus price cannot be weighted, so it is screened
  // out before eligibility rather than being priced on thin evidence.
  const priceable = universe.filter((a) => prices.has(a.symbol));
  const { eligible, excluded } = screen(priceable, methodology);
  if (eligible.length === 0) {
    throw new Error("no eligible constituents after screening; refusing to publish");
  }

  const weights = weight(eligible, methodology);
  const basket = unitsForWeights(weights, prices, BASKET_NOTIONAL_USD);

  // Continuity: the level just before the composition change is the level of
  // the *old* basket at *current* prices. At inception there is no old basket,
  // so the divisor is solved to hit the base level instead.
  let divisor;
  let previousLevel = null;
  if (previousState) {
    previousLevel = level(previousState.basket, prices, previousState.divisor);
    divisor = rebalanceDivisor(basket, prices, previousLevel);
  } else {
    divisor = inceptionDivisor(basket, prices, methodology);
  }

  const levelFloat = level(basket, prices, divisor);
  const epoch = previousState ? previousState.epoch + 1 : 0;
  const hash = methodologyHash(methodology);

  const update = {
    epoch,
    value: toScaledValue(levelFloat).toString(),
    constituents: toBasisPoints(weights),
    methodologyHash: hash,
  };

  return {
    update,
    state: { epoch, basket, divisor, methodologyHash: hash },
    audit: {
      computedAt: new Date().toISOString(),
      methodologyVersion: methodology.version,
      methodologyHash: hash,
      levelDisplay: fromScaledValue(update.value),
      previousLevel,
      prices: Object.fromEntries(
        [...prices].map(([symbol, p]) => [symbol, { price: p.price, sources: p.sources }]),
      ),
      priceRejections: rejected,
      sourceErrors,
      excluded,
    },
  };
}
