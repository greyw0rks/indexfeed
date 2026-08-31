/**
 * Testnet account setup.
 *
 *   node scripts/setup-testnet.js <SECRET> [...]
 *   node scripts/setup-testnet.js --swap 5 <SECRET> [...]
 *
 * Funds each account with Friendbot and adds a USDC trustline. Both steps are
 * required before an account can pay or be paid: an account with no trustline
 * fails at settlement rather than at signing, which is a confusing failure to
 * debug from the client side.
 *
 * `--swap <amount>` additionally acquires USDC by path-paying Friendbot XLM
 * through the Stellar DEX. Circle's Stellar faucet is unreliable, and the DEX
 * yields the *same* asset — the classic USDC's Stellar Asset Contract id is
 * exactly the `USDC_TESTNET_ADDRESS` that `@x402/stellar` expects — so
 * DEX-acquired USDC is indistinguishable from faucet USDC to the payment flow.
 *
 * Testnet only. Friendbot does not exist on pubnet, and testnet DEX prices are
 * whatever offers testers happened to leave on the book, so they bear no
 * relation to real rates.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** Testnet USDC, as issued by Circle. Mainnet uses a different issuer. */
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

/**
 * Slippage tolerance on the XLM leg. The testnet book is thin and arbitrary, so
 * this is generous — the XLM is free, and a failed swap costs more time than an
 * unfavourable rate costs anything.
 */
const SLIPPAGE = 1.5;

const server = new Horizon.Server(HORIZON_URL);

async function fund(publicKey) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${publicKey}`);
  // 400 usually means "already funded", which is not a failure for our purpose.
  if (!res.ok && res.status !== 400) throw new Error(`friendbot ${res.status} for ${publicKey}`);
  return res.ok;
}

async function hasTrustline(publicKey) {
  const account = await server.loadAccount(publicKey);
  return account.balances.some(
    (b) => b.asset_code === USDC.getCode() && b.asset_issuer === USDC.getIssuer(),
  );
}

async function addTrustline(keypair) {
  const account = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
}

function usdcBalance(account) {
  const held = account.balances.find(
    (b) => b.asset_code === USDC.getCode() && b.asset_issuer === USDC.getIssuer(),
  );
  return held?.balance ?? "0";
}

/**
 * Buy `amount` USDC with XLM via a strict-receive path payment.
 *
 * Strict-receive rather than strict-send so the USDC delivered is exact and the
 * XLM spent is whatever the book charges — the reverse would leave an
 * unpredictable balance, and the point here is a known amount to pay with.
 */
async function swapForUsdc(keypair, amount) {
  const paths = await server
    .strictReceivePaths([Asset.native()], USDC, String(amount))
    .call();
  const best = paths.records[0];
  if (!best) {
    throw new Error(
      `no XLM -> USDC path for ${amount} USDC on the testnet DEX; try a smaller amount`,
    );
  }

  const sendMax = (Number(best.source_amount) * SLIPPAGE).toFixed(7);
  console.log(
    `  path: ${best.source_amount} XLM -> ${best.destination_amount} USDC (${best.path.length} hops)`,
  );

  const account = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: keypair.publicKey(),
        destAsset: USDC,
        destAmount: String(amount),
        // Reuse the quoted route. An empty path would only match a direct
        // offer, which need not exist even when a multi-hop route does.
        path: best.path.map((hop) =>
          hop.asset_type === "native" ? Asset.native() : new Asset(hop.asset_code, hop.asset_issuer),
        ),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
}

async function setup(secret, { swapAmount }) {
  const keypair = Keypair.fromSecret(secret);
  const publicKey = keypair.publicKey();

  const funded = await fund(publicKey);
  console.log(`${publicKey}  ${funded ? "funded" : "already funded"}`);

  if (await hasTrustline(publicKey)) {
    console.log("  USDC trustline present");
  } else {
    await addTrustline(keypair);
    console.log("  USDC trustline added");
  }

  if (swapAmount) {
    await swapForUsdc(keypair, swapAmount);
    console.log("  swapped");
  }

  console.log(`  balance: ${usdcBalance(await server.loadAccount(publicKey))} USDC`);
}

const args = process.argv.slice(2);
let swapAmount = null;
const swapIndex = args.indexOf("--swap");
if (swapIndex !== -1) {
  swapAmount = Number(args[swapIndex + 1]);
  if (!Number.isFinite(swapAmount) || swapAmount <= 0) {
    console.error("--swap needs a positive amount, e.g. --swap 5");
    process.exit(1);
  }
  args.splice(swapIndex, 2);
}

if (args.length === 0) {
  console.error("usage: setup-testnet.js [--swap <amount>] <STELLAR_SECRET> [...]");
  process.exit(1);
}

for (const secret of args) {
  await setup(secret, { swapAmount }).catch((err) => {
    const detail = err.response?.data?.extras?.result_codes ?? err.message;
    console.error(`  failed: ${JSON.stringify(detail)}`);
    process.exitCode = 1;
  });
}

console.log(`\nUSDC issuer: ${USDC.getIssuer()}`);
if (!swapAmount) {
  console.log("No USDC acquired. Use --swap <amount> to buy some with XLM on the testnet DEX,");
  console.log("or try https://faucet.circle.com (select Stellar) if it is back up.");
}
