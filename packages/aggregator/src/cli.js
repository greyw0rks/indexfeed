/**
 * Aggregator CLI.
 *
 *   node src/cli.js rebalance [--dry-run]   compute (and optionally publish) the next epoch
 *   node src/cli.js init                    initialize a freshly deployed contract
 *   node src/cli.js status                  show on-chain head and local state
 */
import { buildSources, loadConfig } from "./config.js";
import { SEED_UNIVERSE } from "./universe.js";
import { runRebalance } from "./rebalance.js";
import { stateStore } from "./state.js";
import { createPublisher } from "./publisher.js";
import { fromScaledValue } from "./index-math.js";

function requirePublisher(config) {
  return createPublisher({
    secretKey: config.publisherSecret,
    contractId: config.contractId,
    network: config.network,
    rpcUrl: config.rpcUrl,
  });
}

async function cmdRebalance({ dryRun }) {
  const config = loadConfig();
  const store = stateStore(config.stateDir);
  const previousState = await store.load();

  const { update, state, audit } = await runRebalance({
    sources: buildSources(config),
    universe: SEED_UNIVERSE,
    previousState,
  });

  console.log(`epoch ${update.epoch}  level ${audit.levelDisplay}  methodology ${audit.methodologyHash.slice(0, 12)}…`);
  for (const c of update.constituents) {
    console.log(`  ${c.symbol.padEnd(6)} ${(c.weight_bps / 100).toFixed(2)}%`);
  }
  if (audit.sourceErrors.length) console.warn("source errors:", audit.sourceErrors);
  if (audit.priceRejections.length) console.warn("price rejections:", audit.priceRejections);

  if (dryRun) {
    console.log("dry run — nothing published, state unchanged");
    return;
  }

  const publisher = requirePublisher(config);
  // The contract is the authority on epoch ordering; check it before spending a
  // fee on an update local state thinks is next but the chain has already seen.
  const onChainHead = await publisher.head();
  const expected = onChainHead === null ? 0 : onChainHead + 1;
  if (update.epoch !== expected) {
    throw new Error(
      `local state is out of sync: computed epoch ${update.epoch}, chain expects ${expected}`,
    );
  }

  const { hash } = await publisher.publish(update);
  // State is written only after the chain confirms, so a failed publish leaves
  // the next run recomputing the same epoch rather than skipping one.
  await store.save(state);
  const auditPath = await store.saveAudit(update.epoch, { ...audit, txHash: hash });
  console.log(`published epoch ${update.epoch} in tx ${hash}`);
  console.log(`audit written to ${auditPath}`);
}

async function cmdInit() {
  const config = loadConfig();
  if (!config.adminPublicKey) throw new Error("ADMIN_PUBLIC_KEY is required to initialize");
  const publisher = requirePublisher(config);
  const { hash } = await publisher.initialize(config.adminPublicKey);
  console.log(`initialized ${config.contractId} in tx ${hash}`);
  console.log(`admin ${config.adminPublicKey}  publisher ${publisher.publicKey}`);
}

async function cmdStatus() {
  const config = loadConfig();
  const store = stateStore(config.stateDir);
  const local = await store.load();
  console.log(`network       ${config.network}`);
  console.log(`contract      ${config.contractId ?? "(unset)"}`);
  console.log(`local epoch   ${local ? local.epoch : "(none)"}`);

  if (!config.contractId || !config.publisherSecret) {
    console.log("chain         skipped (contract id or publisher key unset)");
    return;
  }
  const publisher = requirePublisher(config);
  const head = await publisher.head();
  if (head === null) {
    console.log("chain epoch   (none published)");
    return;
  }
  const latest = await publisher.latest();
  console.log(`chain epoch   ${head}`);
  console.log(`chain level   ${fromScaledValue(latest.value)}`);
  console.log(`published at  ${new Date(Number(latest.published_at) * 1000).toISOString()}`);
}

const [command, ...flags] = process.argv.slice(2);
const commands = {
  rebalance: () => cmdRebalance({ dryRun: flags.includes("--dry-run") }),
  init: cmdInit,
  status: cmdStatus,
};

const run = commands[command];
if (!run) {
  console.error(`usage: cli.js <${Object.keys(commands).join("|")}> [--dry-run]`);
  process.exit(1);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
