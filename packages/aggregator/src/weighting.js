/**
 * Eligibility screening and free-float market-cap weighting with a
 * concentration cap.
 */
import { METHODOLOGY, TOTAL_WEIGHT_BPS } from "./methodology.js";

/**
 * Apply the eligibility rules to a candidate universe.
 *
 * @param {Array<{symbol: string, freeFloatMarketCapUsd: number,
 *   avgDailyVolumeUsd: number, listingAgeDays: number, isStablecoin?: boolean}>} universe
 * @returns {{eligible: Array, excluded: Array<{symbol: string, reason: string}>}}
 */
export function screen(universe, methodology = METHODOLOGY) {
  const rules = methodology.eligibility;
  const eligible = [];
  const excluded = [];

  for (const asset of universe) {
    let reason = null;
    if (rules.excludeStablecoins && asset.isStablecoin) reason = "stablecoin";
    else if (asset.freeFloatMarketCapUsd < rules.minMarketCapUsd) reason = "market_cap";
    else if (asset.avgDailyVolumeUsd < rules.minAvgDailyVolumeUsd) reason = "volume";
    else if (asset.listingAgeDays < rules.minListingAgeDays) reason = "listing_age";

    if (reason) excluded.push({ symbol: asset.symbol, reason });
    else eligible.push(asset);
  }

  // Largest free float first, then take the top N.
  eligible.sort((a, b) => b.freeFloatMarketCapUsd - a.freeFloatMarketCapUsd);
  const selected = eligible.slice(0, methodology.targetSize);
  for (const asset of eligible.slice(methodology.targetSize)) {
    excluded.push({ symbol: asset.symbol, reason: "below_target_size" });
  }

  return { eligible: selected, excluded };
}

/**
 * Free-float market-cap weights with an iterative concentration cap.
 *
 * Capping one name pushes its excess onto the others, which can lift a second
 * name over the cap — so this repeats until no name breaches it. Uncapped names
 * absorb the excess in proportion to their own weight.
 *
 * @returns {Array<{symbol: string, weight: number}>} weights as fractions summing to 1
 */
export function weight(assets, methodology = METHODOLOGY) {
  const cap = methodology.concentrationCapBps / TOTAL_WEIGHT_BPS;
  if (assets.length === 0) return [];

  // A cap below an equal split is unsatisfiable — every name would breach it.
  if (cap * assets.length < 1) {
    throw new Error(
      `concentrationCapBps ${methodology.concentrationCapBps} cannot be met with ` +
        `${assets.length} constituents (needs >= ${Math.ceil(TOTAL_WEIGHT_BPS / assets.length)})`,
    );
  }

  const total = assets.reduce((s, a) => s + a.freeFloatMarketCapUsd, 0);
  const weights = new Map(assets.map((a) => [a.symbol, a.freeFloatMarketCapUsd / total]));
  const capped = new Set();

  // Bounded by the number of names: each pass caps at least one more, or stops.
  for (let pass = 0; pass < assets.length; pass += 1) {
    const breaching = [...weights].filter(([s, w]) => !capped.has(s) && w > cap + 1e-12);
    if (breaching.length === 0) break;

    for (const [symbol] of breaching) {
      weights.set(symbol, cap);
      capped.add(symbol);
    }

    const cappedWeight = capped.size * cap;
    const freeSymbols = assets.map((a) => a.symbol).filter((s) => !capped.has(s));
    const freeWeight = freeSymbols.reduce((s, sym) => s + weights.get(sym), 0);
    const remaining = 1 - cappedWeight;
    for (const sym of freeSymbols) {
      weights.set(sym, freeWeight === 0 ? remaining / freeSymbols.length : (weights.get(sym) / freeWeight) * remaining);
    }
  }

  return assets.map((a) => ({ symbol: a.symbol, weight: weights.get(a.symbol) }));
}

/**
 * Convert fractional weights to basis points that sum to exactly 10_000.
 *
 * The contract rejects any update whose weights do not sum to 10_000, so the
 * rounding residual is assigned to the largest name — the one where a 1bp
 * adjustment is least material.
 */
export function toBasisPoints(weights) {
  if (weights.length === 0) return [];
  const bps = weights.map((w) => ({ symbol: w.symbol, weight_bps: Math.round(w.weight * TOTAL_WEIGHT_BPS) }));
  const residual = TOTAL_WEIGHT_BPS - bps.reduce((s, b) => s + b.weight_bps, 0);
  if (residual !== 0) {
    const largest = bps.reduce((a, b) => (b.weight_bps > a.weight_bps ? b : a));
    largest.weight_bps += residual;
  }
  return bps;
}
