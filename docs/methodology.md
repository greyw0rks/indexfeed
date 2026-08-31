# IndexFeed Methodology v1.0.0

The rules that decide what the index contains and what it is worth. This document
is the human-readable form of `packages/aggregator/src/methodology.js`; the code is
authoritative, and its SHA-256 hash is published on-chain with every update so a
reader can tell whether two epochs were computed under the same rules.

Methodology hash of v1.0.0: `6b044703b1a9…` (see `node -e` below to recompute).

```bash
cd packages/aggregator
node -e "import('./src/methodology.js').then(m => console.log(m.methodologyHash()))"
```

## 1. Universe

The candidate universe is the set of assets considered for inclusion. Membership
is candidacy, not inclusion — the eligibility screen decides what actually enters
each epoch.

## 2. Eligibility

An asset is eligible when all of the following hold:

| Rule | Threshold | Why |
| --- | --- | --- |
| Free-float market cap | ≥ $50,000,000 | Excludes assets too small to represent the market |
| 30-day average daily volume | ≥ $1,000,000 | Illiquid names cannot be priced or tracked reliably |
| Listing age | ≥ 90 days | Excludes launch-price noise and thin early order books |
| Not a stablecoin | — | Stablecoins track the dollar, not the crypto market |

Eligible assets are ranked by free-float market cap and the top **20** are
selected. An asset without a consensus price (§3) is excluded before screening —
it cannot be weighted, so it is dropped rather than priced on thin evidence.

## 3. Pricing

Prices come from four independent sources of two kinds:

| Source | Kind |
| --- | --- |
| Bitstamp | Exchange |
| Bitfinex | Exchange |
| CoinGecko | Aggregator |
| CoinPaprika | Aggregator |

The distinction matters. Exchanges are genuinely independent — a manipulated print
on one does not appear on the other. Aggregators are volume-weighted composites
across many venues, which makes each robust on its own but *not* independent of the
others; three aggregators would agree with each other while all being wrong in the
same direction. A meaningful consensus needs at least one exchange.

Reconciliation, per asset:

1. Discard non-finite and non-positive quotes.
2. Require at least **2** surviving sources, else the asset is excluded from the epoch.
3. Take the median of the remaining quotes as the reference.
4. Discard any source deviating more than **500bps** from the reference.
5. Require at least **2** sources still surviving, else exclude the asset.
6. The consensus price is the median of the survivors.

The median is used rather than the mean at step 3 because the mean would be dragged
toward the very outlier being screened for. A single manipulated source therefore
cannot move the published price by more than the deviation band.

A source that errors or times out contributes no quotes and does not fail the
rebalance — reachability is not uniform across hosts, so a dead source is a normal
condition rather than an incident.

## 4. Weighting

Weights are **free-float-adjusted market capitalization**, with a **25%**
concentration cap per constituent.

The cap is applied iteratively. Capping one name redistributes its excess to the
others in proportion to their own weights, which can lift a second name over the
cap; the process repeats until no name breaches it. Where the cap binds every name
the result is an equal-weight index, which is the correct limiting behaviour.

A cap below an equal split is unsatisfiable — with N constituents the cap must be
at least 10,000/N basis points. The engine refuses such a configuration rather
than silently exceeding the cap.

Weights are published as basis points summing to exactly **10,000**. The contract
rejects any update that does not sum to 10,000; the rounding residual is assigned
to the largest constituent, where a 1bp adjustment is least material.

## 5. Index level

A divisor-based market-capitalization index:

```
level = Σ (price_i × units_i) / divisor
```

The basket is held in **units**, not weights, so between rebalances the weights
drift with price as a real index does rather than being re-pinned on every read.

**At inception** the divisor is solved so the level equals the base level of
**1000**.

**At each rebalance** the divisor is re-solved so the level is continuous across
the composition change:

```
divisor_new = Σ (price_i × units_i,new) / level_before
```

where `level_before` is the level of the *old* basket at *current* prices. This is
the standard continuity adjustment: changing what the index contains must not, by
itself, move the level. Only price movement does.

The level is published as an `i128` scaled by 1e7 (7 decimal places, matching
Stellar's convention). A level of 1000.0 is stored as `10000000000`.

## 6. Rebalance cadence

Every **7 days**. Each rebalance publishes one epoch.

## 7. Versioning and immutability

Epochs are numbered monotonically from 0. The contract accepts epoch N only when
N is exactly `head + 1`, so:

- A published epoch can never be rewritten.
- History can never have gaps.
- A bad update is corrected by publishing the next epoch, never by editing.

Every update carries the 32-byte SHA-256 hash of the methodology object. The hash
covers the whole object under a canonical, key-order-independent serialization, so
reordering the source file does not change the hash, but changing any threshold
does — even if the `version` field is not bumped.

The `version` field should still be bumped on any substantive change, since it is
what humans read.

## 8. Audit trail

Each published epoch writes an immutable record to
`$STATE_DIR/audit/epoch-NNNNN.json` containing the consensus price and contributing
sources for every constituent, discarded sources and price rejections, source
errors, excluded assets with reasons, the resulting level, and the settling
transaction hash. This is what makes a past update reproducible.

The basket units and divisor live in `$STATE_DIR/state.json`. The contract stores
the published *result* but not these, and they are what make the next epoch
continuous with this one — losing that file means the next rebalance cannot
reproduce the divisor.
