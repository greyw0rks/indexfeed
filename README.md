# IndexFeed

On-chain crypto index oracle for Stellar / Soroban, metered per request with x402.

Data flows one direction — off-chain computation into an on-chain source of truth,
metered at the edge — so any consumer, human or agent, reads the same verifiable
number. Payment is the access control: no API keys, no accounts, no subscriptions.

```
[ Price sources ]  Bitstamp · Bitfinex · CoinGecko · CoinPaprika
      |
      v
[ Aggregator & methodology engine ]   packages/aggregator
      |  signs + submits one immutable update per rebalance epoch
      v
[ Soroban oracle contract ]           contracts/  <- source of truth
      |
      v
[ x402-metered API ]                  packages/api
      |
      v
[ Consumers ]                         packages/client (reference consumer)
```

## Status

Phase 1–2 complete, live on Stellar Testnet. All four components are wired end to
end: epoch 0 is published on-chain and paid reads settle real USDC.

| Component | State |
| --- | --- |
| Oracle contract | Deployed to Testnet, 8 unit tests passing |
| Aggregator | Live prices from 4 sources, epoch 0 published on-chain |
| x402 API | Serving; all three paid routes settle end to end |
| Reference client | Completes payment and reads — no API key, no account |

Testnet contract: `CCZ3LJZVCJ5XVLYUQKHZBC7DWCJX5SQRND5WWRSMW3OUB57JWTJ3HKJ3`
([explorer](https://stellar.expert/explorer/testnet/contract/CCZ3LJZVCJ5XVLYUQKHZBC7DWCJX5SQRND5WWRSMW3OUB57JWTJ3HKJ3))

First settled payment: $0.01 USDC,
[`e005a342…7ea8`](https://stellar.expert/explorer/testnet/tx/e005a342d4fe0837a35b0812e5a3825aeec58d8eaca42b187b1997a4d2e57ea8)
(2026-08-31). Fees were sponsored by the facilitator — the payer's account is not
the transaction source.

Not yet done: mainnet deployment, live fundamentals feed, monitoring.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/` | Soroban oracle contract (Rust) — stores epochs, weights, methodology hash |
| `packages/aggregator/` | Price reconciliation, methodology engine, oracle publisher, CLI |
| `packages/api/` | Express + `@x402/express` paid HTTP layer over the contract's reads |
| `packages/client/` | Reference x402 consumer — pays and reads, no API key |
| `scripts/` | Testnet account setup (fund + USDC trustline) |
| `docs/` | Methodology specification and deployment runbook |

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the values

# Contract
npm run contracts:test        # 8 tests, no network needed
npm run contracts:build       # requires the stellar CLI

# Aggregator — compute an epoch without touching the chain
cd packages/aggregator
USE_FIXTURE_PRICES=1 node src/cli.js rebalance --dry-run   # offline
node src/cli.js rebalance --dry-run                        # live prices
node src/cli.js status                                     # local vs on-chain state

# API
cd packages/api && npm start

# Client
cd packages/client
node src/cli.js describe      # free: prices and network
node src/cli.js latest        # pays, then reads
```

## How it works

**Prices.** Four sources, deliberately of two kinds. Bitstamp and Bitfinex are
independent exchanges; CoinGecko and CoinPaprika are volume-weighted composites.
Composites are robust individually but not independent of each other, so a
consensus built only from aggregators would agree with itself while being wrong.
A price needs two sources agreeing within 500bps of their median; outliers are
dropped and an asset with no consensus is excluded from the epoch rather than
priced on thin evidence.

**Weights.** Free-float market-cap weights with a 25% concentration cap, applied
iteratively — capping one name pushes weight onto the others, which can push a
second name over the cap. Weights are converted to basis points summing to
exactly 10,000, with the rounding residual assigned to the largest name.

**Level.** A divisor-based index. At inception the divisor is solved so the level
is 1000. On every later rebalance it is re-solved so that changing the
constituent set does not, by itself, move the level — only price movement does.
The basket is held in units, so weights drift with price between rebalances like
a real index.

**Immutability.** `publish` accepts epoch N only when N is exactly `head + 1`.
Republishing a past epoch and skipping ahead are both rejected on-chain, so a bad
update is superseded by the next epoch and never edited. Every update carries a
hash of the methodology it was computed under, so a reader can tell whether two
epochs used the same rules.

**Metering.** `@x402/express` gates the data routes. An unpaid request gets a 402
with a base64 `payment-required` header naming the price, asset, network, and
payee; the client signs, retries, and the facilitator settles. Free routes are
limited to service metadata and liveness — a client has to see the price before it
can decide to pay, and neither leaks index data.

## Keys

Three separate roles, deliberately not shared:

| Key | Holds | Exposure |
| --- | --- | --- |
| Publisher | Contract write access | Aggregator only, server-side |
| Admin | Can rotate the publisher | Offline / separate custody |
| PayTo | Receives x402 payments | Public by nature; needs a USDC trustline |

The API holds none of them — it is read-only against the contract. Compromising
the paid endpoint cannot forge an index update.

## Remaining work

- **Live fundamentals.** `SEED_UNIVERSE` in `packages/aggregator/src/universe.js`
  is a static snapshot. Eligibility reads from it, so a stale snapshot means a
  stale index. Prices are live; the composition inputs are not.
- **Mainnet.** Needs a provider RPC URL (pubnet has no public RPC), a mainnet
  facilitator (`www.x402.org/facilitator` is testnet-only), and the mainnet USDC
  issuer.
- **Monitoring.** Uptime and query volume, per the Phase 4 exit criteria.

## Getting testnet USDC

Circle's Stellar faucet is unreliable. The setup script can buy USDC with
Friendbot XLM through Stellar's native DEX instead:

```bash
node scripts/setup-testnet.js --swap 5 <STELLAR_SECRET>
```

This funds the account, adds the USDC trustline, and path-pays XLM for USDC. It
yields the *same* asset: classic USDC's Stellar Asset Contract id is exactly the
`USDC_TESTNET_ADDRESS` that `@x402/stellar` expects, so DEX-acquired USDC is
indistinguishable from faucet USDC to the payment flow.

Testnet DEX prices are whatever offers testers left on the book and bear no
relation to real rates — at time of writing 2.88 XLM bought 5 USDC. The XLM is
free, so this does not matter.

Both the paying account and `X402_PAY_TO` need a trustline. Without one a payment
fails at *settlement*, not at signing, so the integration looks healthy right up
to the first real payment.

See `docs/deployment.md` for the runbook and `docs/methodology.md` for the index
rules.
