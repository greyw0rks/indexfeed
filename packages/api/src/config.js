/**
 * API configuration.
 *
 * The API holds no publishing key — it is read-only against the contract. Its
 * only secret-adjacent value is the facilitator URL, and the payout address is
 * public by nature.
 */
import { loadEnv } from "@indexfeed/aggregator/env";

loadEnv(process.cwd());

export const NETWORK_CAIP2 = {
  testnet: "stellar:testnet",
  pubnet: "stellar:pubnet",
};

export function loadApiConfig(env = process.env) {
  const network = env.STELLAR_NETWORK ?? "testnet";
  const caip2 = NETWORK_CAIP2[network];
  if (!caip2) throw new Error(`unknown STELLAR_NETWORK ${network}; expected testnet or pubnet`);

  const config = {
    port: Number(env.PORT ?? 3001),
    network,
    caip2,
    rpcUrl: env.STELLAR_RPC_URL ?? undefined,
    contractId: env.ORACLE_CONTRACT_ID,
    /**
     * A funded account used only as the source for read simulations. It signs
     * nothing and spends nothing; simulation just needs an existing account.
     */
    readSourceAccount: env.READ_SOURCE_ACCOUNT,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? "https://www.x402.org/facilitator",
    /** Where payments land. Needs a USDC trustline before it can be paid. */
    payTo: env.X402_PAY_TO,
    prices: {
      latest: env.PRICE_LATEST ?? "$0.01",
      value: env.PRICE_VALUE ?? "$0.005",
      history: env.PRICE_HISTORY ?? "$0.02",
    },
    /** Seconds a cached on-chain read is served for. Bounds RPC load. */
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 15),
  };

  const missing = ["contractId", "readSourceAccount", "payTo"].filter((k) => !config[k]);
  if (missing.length) {
    const names = { contractId: "ORACLE_CONTRACT_ID", readSourceAccount: "READ_SOURCE_ACCOUNT", payTo: "X402_PAY_TO" };
    throw new Error(`missing required env: ${missing.map((k) => names[k]).join(", ")}`);
  }
  if (network === "pubnet" && !config.rpcUrl) {
    throw new Error("pubnet has no public RPC; set STELLAR_RPC_URL to a provider URL");
  }

  return config;
}
