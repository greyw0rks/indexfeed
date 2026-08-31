/**
 * Methodology constants and the versioning hash.
 *
 * Everything the index's composition depends on lives here. The hash of this
 * object is published on-chain with every update, so a reader can tell whether
 * two epochs were computed under the same rules.
 */
import { createHash } from "node:crypto";

/** Weights on-chain are basis points summing to 10_000. */
export const TOTAL_WEIGHT_BPS = 10_000;

/** Index level is stored at 7dp, matching Stellar's convention. */
export const VALUE_DECIMALS = 7;
export const VALUE_SCALE = 10n ** BigInt(VALUE_DECIMALS);

/**
 * Bump `version` on any change to these rules. Because the hash covers the
 * whole object, forgetting to bump is still detectable — the hash moves anyway.
 */
export const METHODOLOGY = {
  version: "1.0.0",
  /** Target constituent count for the flagship index. */
  targetSize: 20,
  /** No single name may exceed this share, applied iteratively. */
  concentrationCapBps: 2_500,
  eligibility: {
    /** Minimum free-float market cap in USD. */
    minMarketCapUsd: 50_000_000,
    /** Minimum 30-day average daily volume in USD. */
    minAvgDailyVolumeUsd: 1_000_000,
    /** Minimum days since first listing, to exclude launch-price noise. */
    minListingAgeDays: 90,
    /** Stablecoins track the dollar, not the market; they are not index names. */
    excludeStablecoins: true,
  },
  /** Rebalance cadence in days. Epoch N is published every `cadenceDays`. */
  cadenceDays: 7,
  pricing: {
    /** Minimum independent sources required before a price is usable. */
    minSources: 2,
    /**
     * A source is discarded when it deviates from the median by more than this.
     * Guards against a single venue printing a bad tick or being manipulated.
     */
    maxDeviationBps: 500,
  },
  /** Divisor anchoring the index to its base level of 1000 at inception. */
  baseLevel: 1_000,
};

/**
 * Stable stringify — key order must not affect the hash, or an innocuous
 * refactor of this file would look like a methodology change on-chain.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 32-byte methodology hash, hex encoded, as published on-chain. */
export function methodologyHash(methodology = METHODOLOGY) {
  return createHash("sha256").update(canonicalize(methodology)).digest("hex");
}
