# Deployment Runbook

## Toolchain

| Tool | Version used | Notes |
| --- | --- | --- |
| Node | 22 | Workspaces, native test runner |
| Rust | 1.96 | `wasm32v1-none` target required |
| stellar CLI | 28.0.0 | `soroban` CLI is superseded by `stellar` |
| soroban-sdk | 27 | Pinned in `contracts/Cargo.toml` |

```bash
rustup target add wasm32v1-none
# stellar CLI: github.com/stellar/stellar-cli/releases
```

## Testnet

Recorded from the live deployment, in order.

### 1. Build

```bash
npm run contracts:test    # 8 tests, no network
npm run contracts:build   # -> contracts/target/wasm32v1-none/release/indexfeed_oracle.wasm
```

The build reports the exported functions. All nine should be present:
`initialize`, `publish`, `value`, `latest`, `at_epoch`, `head`, `publisher`,
`set_publisher`, `decimals`.

### 2. Accounts

Four roles. Generate each with `Keypair.random()` and fund via Friendbot.

| Role | Needs |
| --- | --- |
| Publisher | XLM (pays contract fees) |
| Admin | XLM |
| PayTo | XLM **and a USDC trustline** |
| Client | XLM, a USDC trustline, **and USDC** |

```bash
node scripts/setup-testnet.js <SECRET> [...]            # fund + add trustline
node scripts/setup-testnet.js --swap 5 <SECRET>         # ...and buy 5 USDC with XLM
```

**Getting USDC.** Circle's Stellar faucet
([faucet.circle.com](https://faucet.circle.com)) is unreliable — other chains work
while Stellar fails. `--swap` sidesteps it by path-paying Friendbot XLM through
Stellar's native DEX, which is a protocol feature and so exists on testnet.

This yields the same asset, not a substitute: classic USDC's Stellar Asset Contract
id derives to `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, which is
exactly the `USDC_TESTNET_ADDRESS` that `@x402/stellar` uses as its default asset.

Testnet DEX prices are arbitrary — whatever offers testers left on the book. At
time of writing 2.88 XLM bought 5 USDC, against a real XLM price near $0.176. The
XLM is free, so this is irrelevant, but do not read the rate as meaningful.

CCTP from another testnet (e.g. Arc) is an alternative, but it presupposes USDC on
the source chain and its documented funding route is the same Circle faucet.

The trustlines are not optional. An account without one fails at *settlement*, not
at signing, so the whole flow looks healthy until the first real payment.

### 3. Deploy

```bash
stellar keys add if-publisher --secret-key   # paste the publisher secret
cd contracts
stellar contract deploy \
  --wasm target/wasm32v1-none/release/indexfeed_oracle.wasm \
  --source if-publisher --network testnet
```

Record the contract id into `ORACLE_CONTRACT_ID`.

### 4. Initialize

```bash
cd packages/aggregator && node src/cli.js init
```

Sets admin and publisher. `initialize` is one-shot — a second call returns
`AlreadyInitialized`.

### 5. Publish the first epoch

```bash
node src/cli.js rebalance --dry-run   # compute only, no transaction
node src/cli.js rebalance             # compute, publish, write state + audit
node src/cli.js status                # local epoch vs chain epoch
```

`rebalance` checks the on-chain head before spending a fee, and writes local state
only *after* the chain confirms — so a failed publish leaves the next run
recomputing the same epoch rather than skipping one.

Verified across two epochs on 2026-08-31:

| Epoch | Level | Tx |
| --- | --- | --- |
| 0 | 1000.0000000 | `3301c9a4…d044` |
| 1 | 999.1509525 | `1adbd84a…a702` |

The level moved on price movement alone — the constituent set was unchanged, and
the divisor was re-solved so recomposition contributed nothing. Epoch 0 remains
readable at its original value via `at_epoch`, which is the immutability guarantee
holding in practice rather than only in the unit tests.

### 6. Serve

```bash
cd packages/api && npm start
curl localhost:3001/                    # free metadata
curl -i localhost:3001/v1/index/latest  # 402 + payment-required header
```

### 7. Pay

```bash
cd packages/client
node src/cli.js describe   # free: prices, network, contract id
node src/cli.js latest     # 402 -> sign -> settle -> data
```

Verified 2026-08-31. All three paid routes settle:

| Route | Price | Settlement tx |
| --- | --- | --- |
| `/v1/index/latest` | $0.01 | `e005a342…7ea8` |
| `/v1/index/value` | $0.005 | `3e467a2e…5509` |
| `/v1/index/epoch/0` | $0.02 | `7bf9f553…f52b` |

Balances moved as expected: payer 5.0 → 4.965 USDC, payee 0 → 0.035.

Two things worth knowing from the live run:

- The settlement transaction's source account is the **facilitator**, not the
  payer — fees are sponsored, so do not look for the payer as the tx source when
  verifying a payment. Confirm by the USDC balance change instead.
- Payment is charged **before** the handler runs, so a paid request for a
  nonexistent epoch settles and then returns 404. This is inherent to metering at
  the edge: the server cannot know the epoch is missing until it has read the
  chain, which is the thing being paid for. Worth documenting for consumers.

## Mainnet

Not yet done. The differences that matter:

- **RPC.** Pubnet has no public RPC endpoint. `STELLAR_RPC_URL` must point at a
  provider ([list](https://developers.stellar.org/docs/data/apis/rpc/providers)).
  The config refuses to start on pubnet without it.
- **Facilitator.** `https://www.x402.org/facilitator` is Coinbase's *testnet*
  facilitator. A pubnet facilitator must be chosen or self-hosted (the OpenZeppelin
  Relayer plugin is the documented route). Verify before switching networks —
  pointing a mainnet deployment at a testnet facilitator fails at settlement.
- **USDC.** A different issuer than testnet. The `payTo` account needs a trustline
  to the mainnet asset.
- **Keys.** Generate fresh publisher and admin keys. Do not reuse testnet keys.

## Key management

| Key | Role | Where it lives |
| --- | --- | --- |
| Publisher | Only key that can write the index | Aggregator host, server-side only |
| Admin | Can rotate the publisher | Offline / separate custody path |
| PayTo | Receives payments | Public; only needs a trustline |

The publisher and admin keys are deliberately separate so the hot publishing key
can be replaced (`set_publisher`) without touching governance. The API holds
neither — it is read-only against the contract, so compromising the paid endpoint
cannot forge an index update.

## Risk controls

- Epochs are immutable on-chain: `publish` accepts only `head + 1`, so a bad update
  is superseded rather than edited, and history cannot gain gaps.
- The facilitator sponsors transaction fees, so a fee spike cannot break the payment
  flow.
- A price source that is unreachable or manipulated is discarded by reconciliation;
  an asset with no consensus is excluded from the epoch rather than published at a
  bad price.
- The reference client enforces a per-request spend ceiling
  (`MAX_PRICE_PER_REQUEST`), so a misconfigured or hostile server cannot name an
  arbitrary price and have it signed.

## Failure modes seen in practice

| Symptom | Cause |
| --- | --- |
| `Error(Value, UnexpectedType)` on publish, `map_unpack_to_linear_memory` in the event log | Soroban struct fields must be **symbol**-keyed and sorted. `nativeToScVal` on a plain JS object encodes string keys. |
| `no eligible constituents after screening` | Too few price sources reachable. Binance, Kraken, Coinbase, and OKX are geo-blocked from some hosts. |
| Payment signs but never settles | Missing USDC trustline on the paying or receiving account. |
| Circle faucet fails for Stellar while other chains work | Known flaky. Use `setup-testnet.js --swap` to buy USDC on the DEX instead. |
| Settlement tx source is not the payer | Expected — the facilitator sponsors fees. Verify by USDC balance change. |
| A paid request returns 404 | Payment settles before the handler runs; the epoch did not exist. |
| `EpochOutOfOrder` | Local state and chain disagree. `node src/cli.js status` shows both. |
| Contract error 3 (`NoData`) from the API | Nothing published yet; surfaces as HTTP 503. |
