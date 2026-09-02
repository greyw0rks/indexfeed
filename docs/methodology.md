# IndexFeed Methodology v1.1.0

The rules that decide what the index contains and what it is worth. This document
is the human-readable form of `packages/aggregator/src/methodology.js`; the code is
authoritative, and its SHA-256 hash is published on-chain with every update so a
reader can tell whether two epochs were computed under the same rules.

Methodology hash of v1.1.0: `65a4bcc8943d…` (see `node -e` below to recompute).
Epochs 0 and 1 were published under v1.0.0 (`6b044703b1a9…`), which screened a
static universe snapshot; the hash change is how that difference is visible
on-chain.

```bash
cd packages/aggregator
node -e "import('./src/methodology.js').then(m => console.log(m.methodologyHash()))"
```

## 1. Universe

The candidate universe is discovered live from two fundamentals providers —
CoinGecko `/coins/markets` and CoinPaprika `/v1/tickers` — drawn from roughly the
top **150** assets by market cap per provider (`UNIVERSE_SIZE`; CoinGecko's free
tier pages at 100 per request, so it fetches in whole pages). Membership is
candidacy, not inclusion; the eligibility screen decides what actually enters
each epoch.

Providers are merged by ticker:

| Field | Merge rule | Why |
| --- | --- | --- |
| Market cap, volume, price, % change | Median of reporting providers | Caps agree within 0.2%; volumes differ 8–25%, so a single provider is not trusted |
| Listing age | **Oldest** claim, nulls ignored | Age is a lower bound; a provider that began tracking late is wrong in a knowable direction |
| Provider ids | Kept per provider | Aggregator price adapters need each provider's own opaque slug (`avalanche-2`, `avax-avalanche`) |

An asset reported by only one provider is kept but records how many providers
saw it, so the screen can act on corroboration. A provider that errors is
recorded in the audit trail and does not fail the rebalance.

## 2. Eligibility

An asset is eligible when all of the following hold:

| Rule | Threshold | Why |
| --- | --- | --- |
| Market cap | ≥ $50,000,000 | Excludes assets too small to represent the market |
| 24h volume | ≥ $1,000,000 | Absolute floor on tradeability |
| Turnover (24h volume ÷ market cap) | ≥ 50bps | Scale-invariant liquidity test; the load-bearing rule |
| Listing age | ≥ 90 days | Excludes launch-price noise and thin early order books |
| Reporting providers | ≥ 1 | Corroboration floor |
| Not a stablecoin, derivative, or commodity token | — | See §2.1 |

Market cap is computed on **circulating supply**, the closest free-data proxy for
free float. It excludes unissued supply but not locked, treasury, or team
holdings, so it overstates float for assets with large vesting schedules.

Turnover is the rule that matters and the absolute volume floor is only a
backstop. Weights are market-cap proportional, so an illiquid mega-cap receives a
weight its order book cannot support — the index would claim exposure that could
not be traded. Measured 2026-08-31: LEO showed a $8.9B cap against $0.2M of daily
volume (0.002%) while AAVE at $1.9B traded $231M (12%). The absolute floor alone
would have ranked LEO 4th by weight.

Eligible assets are ranked by market cap and the top **20** are selected.

Screening runs **before** pricing: it reads provider data already in hand, so
doing it first avoids fetching exchange quotes for names that cannot enter. An
asset that passes screening but has no consensus price (§3) is dropped from the
epoch as a *pricing* failure, and is reported separately from an eligibility one.

### 2.1 What is not an index name

Stablecoins track the dollar rather than the crypto market. Wrapped and staked
derivatives duplicate exposure already in the index — WBTC alongside BTC is the
same bet twice. Commodity tokens are gold exposure wearing a token. All three are
excluded by classification rather than by denylist, because a denylist goes stale
the moment a new derivative launches.

There is no free, reliable tag API for this: CoinPaprika's `/coins/{id}` tags are
inconsistent (stETH is tagged "Liquid Staking Token" while WBTC and USDT carry no
tags) and cost one request per asset. Two complementary signals are used instead:

| Signal | Catches | Rule |
| --- | --- | --- |
| Realized volatility | Stablecoins | \|24h change\| ≤ 0.5% **and** \|7d change\| ≤ 0.5% |
| Naming and ticker patterns | Wrapped, staked, bridged, synthetic assets | `wrapped`/`staked`/`bridged`/`pegged`/`synthetic`/`tokenized` in the name, plus a short ticker list |

Both windows must be quiet for the volatility test to convict, because a flat 24h
is ordinary for any large asset. Verified 2026-08-31: every known stablecoin moved
≤0.10% over both windows while the least volatile non-stable moved 0.79%. The test
is peg-agnostic, so it correctly catches yield-bearing stables trading at 1.25
(sUSDe) or 1.11 (sUSDS) that a "price near $1" test would miss.

Derivatives track their underlying's volatility exactly, so the volatility signal
cannot see them — hence the second signal. Classification runs before the numeric
rules and commodity/derivative checks run before the stablecoin check, so an asset
is reported under its structural reason rather than whichever rule it also happens
to fail.

An asset missing either change window cannot be tested for stability and is
excluded as `unknown_volatility`. Excluding is the safe direction: admitting a
stablecoin corrupts the index, while excluding one real asset costs a slot in a
20-name index.

Every exclusion is written to the audit trail with its reason, so a wrong call is
visible rather than silent.

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

Weights are **market-capitalization** proportional, on the circulating-supply
basis described in §2, with a **25%** concentration cap per constituent.

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
