/**
 * Reference IndexFeed consumer.
 *
 * Demonstrates the whole point of the x402 layer: a caller with a funded wallet
 * and no account, key, or subscription can read the index. `@x402/fetch`
 * transparently handles the 402 — first request is unpaid, the wrapper signs
 * and retries.
 */
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

export const NETWORK_CAIP2 = { testnet: "stellar:testnet", pubnet: "stellar:pubnet" };

/**
 * A fetch that pays. The wallet must hold USDC and a trustline to it; without
 * the trustline the payment fails at settlement, not at signing.
 *
 * @param {object} params
 * @param {string} params.secretKey Stellar secret key (S...) of the paying wallet
 * @param {"testnet"|"pubnet"} params.network
 * @param {string} params.maxPricePerRequest USD ceiling per request, e.g. "$0.05"
 */
export function createPayingFetch({
  secretKey,
  network = "testnet",
  maxPricePerRequest = "$0.05",
  rpcUrl,
}) {
  if (!secretKey) throw new Error("a Stellar secret key is required to pay");
  const caip2 = NETWORK_CAIP2[network];
  if (!caip2) throw new Error(`unknown network ${network}`);

  const signer = createEd25519Signer(secretKey, caip2);
  const scheme = rpcUrl
    ? new ExactStellarScheme(signer, { url: rpcUrl })
    : new ExactStellarScheme(signer);

  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "stellar:*", client: scheme }],
    /**
     * A per-request spend ceiling. Without one, a misconfigured or hostile
     * server could name any price and the wrapper would sign for it. The
     * library defaults to $1; the index endpoints cost cents, so this is
     * tightened rather than left at the default.
     */
    spendControls: { maxAmountPerPayment: maxPricePerRequest },
  });
}

/** Typed accessors over the paid endpoints. */
export function createIndexFeedClient({ baseUrl, ...walletOpts }) {
  if (!baseUrl) throw new Error("baseUrl is required");
  const payingFetch = createPayingFetch(walletOpts);
  const root = baseUrl.replace(/\/$/, "");

  async function paid(path) {
    const res = await payingFetch(`${root}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`${path} failed ${res.status}: ${await res.text()}`);
    }
    const settlement = res.headers.get("payment-response");
    return {
      data: await res.json(),
      // Proof the request was actually paid for, and the tx that settled it.
      settlement: settlement ? decodePaymentResponseHeader(settlement) : null,
    };
  }

  return {
    /** Free: prices, network, contract id. No payment attempted. */
    async describe() {
      const res = await fetch(`${root}/`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`describe failed ${res.status}`);
      return res.json();
    },
    latest: () => paid("/v1/index/latest"),
    value: () => paid("/v1/index/value"),
    atEpoch: (epoch) => paid(`/v1/index/epoch/${epoch}`),
  };
}
