/**
 * Aggregator CLI.
 *
 *   node src/cli.js rebalance [--dry-run]   compute (and optionally publish) the next epoch
 *   node src/cli.js init                    initialize a freshly deployed contract
 *   node src/cli.js status                  show on-chain head and local state
 *
 * Publishing is gated on the methodology cadence. `--force` publishes anyway;
 * `--if-due` turns a not-due run into a no-op exit instead of an error, which is
 * what a scheduled publisher wants.
 */
import { buildFundamentalsProviders, buildSources, loadConfig } from "./config.js";
import { runRebalance } from "./rebalance.js";
import { stateStore } from "./state.js";
import { createPublisher } from "./publisher.js";
import { fromScaledValue } from "./index-math.js";
import { METHODOLOGY, cadenceGate } from "./methodology.js";

function requirePublisher(config) {
  return createPublisher({
    secretKey: config.publisherSecret,
    contractId: config.contractId,
    network: config.network,
    rpcUrl: config.rpcUrl,
  });
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);

/**
 * Is the next epoch due? Returns null when nothing is published yet, so
 * inception is never gated.
 *
 * Checked against the chain rather than local state: the chain's `published_at`
 * is what a third party sees, and local state can be restored from a backup with
 * a stale timestamp.
 */
async function cadenceCheck(publisher) {
  const head = await publisher.head();
  if (head === null) return null;
  const latest = await publisher.latest();
  const gate = cadenceGate({ publishedAtSeconds: Number(latest.published_at) });
  return {
    ...gate,
    reason:
      `epoch ${head} was published ${hours(gate.elapsedMs)}h ago; the ` +
      `${METHODOLOGY.cadenceDays}-day cadence is not due for another ${hours(gate.remainingMs)}h`,
  };
}

async function cmdRebalance({ dryRun, force, ifDue }) {
  const config = loadConfig();

  // Checked before computing, so a not-due run costs no provider requests.
  if (!dryRun && !force) {
    const cadence = await cadenceCheck(requirePublisher(config));
    if (cadence && !cadence.isDue) {
      if (ifDue) {
        console.log(`${cadence.reason} — nothing to do`);
        return;
      }
      throw new Error(`${cadence.reason}. Pass --force to publish anyway.`);
    }
  }

  const store = stateStore(config.stateDir);
  const previousState = await store.load();

  const { update, state, audit } = await runRebalance({
    sources: buildSources(config),
    fundamentalsProviders: buildFundamentalsProviders(config),
    previousState,
  });

  console.log(`epoch ${update.epoch}  level ${audit.levelDisplay}  methodology ${audit.methodologyHash.slice(0, 12)}…`);
  console.log(`universe ${audit.universeSize} screened -> ${update.constituents.length} constituents`);
  for (const c of update.constituents) {
    const f = audit.fundamentals[c.symbol];
    const mcap = f ? `$${(f.marketCapUsd / 1e9).toFixed(1)}B` : "";
    console.log(`  ${c.symbol.padEnd(7)} ${(c.weight_bps / 100).toFixed(2).padStart(6)}%  ${mcap}`);
  }

  // Exclusions are the audit trail for why a name is absent, so summarize them
  // by reason rather than listing every asset that failed to make a 20-name cut.
  const byReason = new Map();
  for (const e of audit.excluded) {
    if (!byReason.has(e.reason)) byReason.set(e.reason, []);
    byReason.get(e.reason).push(e.symbol);
  }
  if (byReason.size) {
    console.log("excluded:");
    for (const [reason, symbols] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      const shown = symbols.slice(0, 8).join(" ");
      const more = symbols.length > 8 ? ` +${symbols.length - 8} more` : "";
      console.log(`  ${reason.padEnd(20)} ${shown}${more}`);
    }
  }
  if (audit.providerErrors.length) console.warn("provider errors:", audit.providerErrors);
  if (audit.sourceErrors.length) console.warn("source errors:", audit.sourceErrors);
  if (audit.priceRejections.length) {
    console.warn("price rejections:", audit.priceRejections.map((r) => `${r.symbol} (${r.rejected})`).join(", "));
  }

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
  const gate = cadenceGate({ publishedAtSeconds: Number(latest.published_at) });
  console.log(
    gate.isDue
      ? `cadence       due (${hours(gate.elapsedMs)}h since epoch ${head})`
      : `cadence       not due for ${hours(gate.remainingMs)}h`,
  );
}

const [command, ...flags] = process.argv.slice(2);
const commands = {
  rebalance: () =>
    cmdRebalance({
      dryRun: flags.includes("--dry-run"),
      force: flags.includes("--force"),
      ifDue: flags.includes("--if-due"),
    }),
  init: cmdInit,
  status: cmdStatus,
};

const run = commands[command];
if (!run) {
  console.error(
    `usage: cli.js <${Object.keys(commands).join("|")}> [--dry-run] [--force] [--if-due]`,
  );
  process.exit(1);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
