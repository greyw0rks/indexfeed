# What IndexFeed is

*Current as of 2026-09-02. This describes what exists and runs, not what is planned.*

IndexFeed is a crypto market index — like the S&P 500, but for crypto assets —
computed off-chain and published to a Soroban contract on Stellar, where reading it
costs a fraction of a cent paid in USDC at request time.

Two things make it different from a price feed. The index is a *methodology*, not a
number: a documented set of rules about what belongs in the basket and how it is
weighted, hashed and published alongside every update so a reader can prove which
rules produced a given value. And access is priced rather than permissioned — there
are no API keys, no accounts, and no subscriptions, because an unpaid request gets
an HTTP 402 and a paid one gets data. A software agent with a wallet can consume it
without anyone provisioning it access first.

## What runs today

| | |
| --- | --- |
| Network | Stellar Testnet |
| Contract | [`CCZ3LJZ…WTJ3HKJ3`](https://stellar.expert/explorer/testnet/contract/CCZ3LJZVCJ5XVLYUQKHZBC7DWCJX5SQRND5WWRSMW3OUB57JWTJ3HKJ3) |
| Epochs published | 0 and 1 (head at epoch 1, level 999.1509525) |
| Methodology | v1.1.0, hash `65a4bcc8943d…` |
| Paid reads | All three routes settling real USDC |
| Tests | 8 contract, 66 JavaScript |

The three paid routes have each completed a real settlement on Testnet:
`/v1/index/latest` at $0.01 ([`e005a342…7ea8`](https://stellar.expert/explorer/testnet/tx/e005a342d4fe0837a35b0812e5a3825aeec58d8eaca42b187b1997a4d2e57ea8)),
`/v1/index/value` at $0.005, and `/v1/index/epoch/0` at $0.02.

Epoch 1 is the interesting one. It confirms the continuity adjustment works against
the chain rather than only in tests: the level moved 1000.0000000 → 999.1509525 on
price movement alone, and epoch 0 still reads at its original value. Changing what
the index contains does not move the level, and a published epoch is never edited.

## The four components

**Aggregator** (`packages/aggregator`, Node). Discovers the candidate universe from
CoinGecko and CoinPaprika, screens it for eligibility, reconciles prices across four
venues, computes the level, and submits one immutable update per epoch. It holds the
only key with contract write access. A dry run is the identical computation minus the
transaction.

**Oracle contract** (`contracts/`, Rust/Soroban). The source of truth. Stores each
epoch's level, constituent weights, and methodology hash. Accepts epoch N only when
N is exactly `head + 1`, so history can neither be rewritten nor develop gaps.

**API** (`packages/api`, Express + `@x402/express`). A paid read layer over the
contract. Holds none of the signing keys — it is read-only, so compromising the paid
endpoint cannot forge an index update.

**Reference client** (`packages/client`). A consumer that receives a 402, signs a
payment, retries, and reads. Demonstrates the whole loop with no credential of any
kind beyond a funded wallet.

## The decisions that carry weight

Most of the engineering here is in refusing to publish a number that looks fine but
is not defensible. Four places where that shows up:

**Sources are chosen for independence, not count.** Prices come from Bitstamp,
Bitfinex, CoinGecko, and CoinPaprika. The first two are exchanges and genuinely
independent — a manipulated print on one does not appear on the other. The last two
are volume-weighted composites, robust individually but *not* independent of each
other, since they average many of the same venues. Four aggregators would agree with
each other while all being wrong in the same direction. A price needs two sources
within 500bps of their median, and an asset with no consensus is excluded from the
epoch rather than published on thin evidence.

**Liquidity is tested by turnover, not by an absolute floor.** Weights are
market-cap proportional, so an illiquid mega-cap receives a large weight its order
book cannot support — the index would be claiming exposure nobody could actually
trade. Turnover (24h volume ÷ market cap) is scale-invariant and catches exactly
that. Measured on 2026-08-31: LEO showed an $8.9B market cap against $0.2M of daily
volume, while AAVE at $1.9B traded $231M. An absolute volume floor alone would have
ranked LEO 4th by weight.

**What is not an index name is decided by classification, not a denylist.**
Stablecoins track the dollar; wrapped and staked derivatives duplicate exposure
already in the basket (WBTC alongside BTC is the same bet twice); commodity tokens
are gold wearing a token. There is no free, reliable tag API for this, so two
signals are used. Realized volatility over both the 24h and 7d windows catches
stablecoins, and does so peg-agnostically — it correctly catches yield-bearing
stables trading at 1.25 that a "price near $1" test would miss. Derivatives track
their underlying's volatility exactly, so volatility cannot see them; naming and
ticker patterns catch those instead. Both are heuristics, both are reported in the
audit record with the reason, so a wrong call is visible rather than silent.

**A bad update is superseded, never edited.** The contract enforces strict epoch
succession on-chain. Combined with the methodology hash on every update, a reader
can tell not only what the index was at any point but which rules produced it.

## What it is not, yet

- **Not on mainnet.** Two concrete blockers, both external: Stellar pubnet has no
  public RPC endpoint, and `www.x402.org/facilitator` is Coinbase's testnet
  facilitator with no documented pubnet equivalent — mainnet needs a self-hosted one.
- **Not monitored.** No uptime or query-volume instrumentation.
- **Not on a schedule.** The methodology specifies a 7-day rebalance cadence; epochs
  are currently published by hand. Nothing runs it on a timer.
- **Not submitted.** The target is the Stellar Community Fund Build Award, SCF #46
  Integration track, submit-by 2026-11-08. SCF requires an interest form first to be
  invited to submit, and that form has not been filed — it is the nearest real
  deadline, ahead of any remaining code.

One caveat worth stating plainly: epochs 0 and 1 were published under methodology
v1.0.0, which screened a static universe snapshot. The rules changed when universe
discovery went live, so epoch 2 will be the first computed under v1.1.0 and its
composition will shift noticeably. The hash on each update is what makes that
legible instead of mysterious.

## Seeing it work

```bash
npm install && npm run contracts:test          # 8 tests, no network

cd packages/aggregator
USE_FIXTURE_PRICES=1 node src/cli.js rebalance --dry-run   # offline, deterministic
node src/cli.js rebalance --dry-run                        # live providers
node src/cli.js status                                     # local state vs chain
```

The offline fixture universe deliberately contains one asset per exclusion rule, so
a dry run exercises the screen rather than waving everything through. A live run on
2026-09-02 pulled 235 candidates and screened them to 20, computing epoch 2 at
988.3576796 — the pipeline is ready to publish it; nobody has.

See `README.md` for setup, `docs/methodology.md` for the index rules in full, and
`docs/deployment.md` for the runbook.

