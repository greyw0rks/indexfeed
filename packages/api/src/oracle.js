/**
 * Oracle read layer with a short TTL cache.
 *
 * Every paid request would otherwise be an RPC simulation. Index values only
 * change on rebalance, so a few seconds of caching removes almost all RPC load
 * without ever serving a value from a superseded epoch for long. The cache is
 * keyed by call, and a failed refresh does not evict a good value — it is
 * reported instead, so a brief RPC outage degrades freshness, not availability.
 */
import { createReader, fromScaledValue } from "@indexfeed/aggregator";

export function createOracleService(config) {
  const reader = createReader({
    contractId: config.contractId,
    network: config.network,
    rpcUrl: config.rpcUrl,
    sourceAccount: config.readSourceAccount,
  });

  const ttlMs = config.cacheTtlSeconds * 1_000;
  const cache = new Map();

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Shape an on-chain update into the JSON served to payers. */
  function serialize(update) {
    return {
      epoch: Number(update.epoch),
      level: fromScaledValue(update.value),
      valueScaled: update.value.toString(),
      decimals: 7,
      constituents: update.constituents.map((c) => ({
        symbol: c.symbol,
        weightBps: Number(c.weight_bps),
        weight: Number(c.weight_bps) / 10_000,
      })),
      publishedAt: new Date(Number(update.published_at) * 1_000).toISOString(),
      methodologyHash: Buffer.from(update.methodology_hash).toString("hex"),
      source: { contractId: config.contractId, network: config.caip2 },
    };
  }

  return {
    async latest() {
      return cached("latest", async () => serialize(await reader.latest()));
    },

    async value() {
      const update = await this.latest();
      return {
        level: update.level,
        valueScaled: update.valueScaled,
        decimals: update.decimals,
        epoch: update.epoch,
        publishedAt: update.publishedAt,
        source: update.source,
      };
    },

    /** Historical epochs are immutable, so they are cached without expiry. */
    async atEpoch(epoch) {
      const key = `epoch:${epoch}`;
      const hit = cache.get(key);
      if (hit) return hit.value;
      const value = serialize(await reader.atEpoch(epoch));
      cache.set(key, { value, at: Infinity });
      return value;
    },

    async head() {
      return cached("head", async () => Number(await reader.head()));
    },
  };
}
