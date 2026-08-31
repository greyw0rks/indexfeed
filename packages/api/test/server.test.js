import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, buildRoutes } from "../src/server.js";

const CONFIG = {
  port: 0,
  network: "testnet",
  caip2: "stellar:testnet",
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  readSourceAccount: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  facilitatorUrl: "https://www.x402.org/facilitator",
  payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  prices: { latest: "$0.01", value: "$0.005", history: "$0.02" },
  cacheTtlSeconds: 15,
};

const SAMPLE = {
  epoch: 3,
  level: "1042.5000000",
  valueScaled: "10425000000",
  decimals: 7,
  constituents: [{ symbol: "XLM", weightBps: 10_000, weight: 1 }],
  publishedAt: "2026-08-30T00:00:00.000Z",
  methodologyHash: "ab".repeat(32),
  source: { contractId: CONFIG.contractId, network: CONFIG.caip2 },
};

/** Stub oracle so routing and gating are tested without a chain. */
function stubOracle(overrides = {}) {
  return {
    async latest() { return SAMPLE; },
    async value() { return { level: SAMPLE.level, epoch: SAMPLE.epoch }; },
    async atEpoch() { return SAMPLE; },
    async head() { return SAMPLE.epoch; },
    ...overrides,
  };
}

/** Start the app on an ephemeral port and return a fetch helper. */
async function withServer(oracle, fn) {
  const server = createApp(CONFIG, oracle).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn((path, init) => fetch(`${base}${path}`, init));
  } finally {
    server.close();
  }
}

test("service description is free and advertises price and network", async () => {
  await withServer(stubOracle(), async (get) => {
    const res = await get("/");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, "stellar:testnet");
    assert.equal(body.payment.protocol, "x402");
    assert.equal(body.routes.length, 3);
    // The description must not leak the data the routes are charging for.
    assert.ok(!JSON.stringify(body).includes(SAMPLE.level));
  });
});

test("health does not require payment and does not touch the chain", async () => {
  const exploding = stubOracle({
    async latest() { throw new Error("RPC unreachable"); },
  });
  await withServer(exploding, async (get) => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });
});

test("index data is not served without payment", async () => {
  await withServer(stubOracle(), async (get) => {
    for (const path of ["/v1/index/latest", "/v1/index/value", "/v1/index/epoch/0"]) {
      const res = await get(path);
      assert.equal(res.status, 402, `${path} should be paywalled, got ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes(SAMPLE.valueScaled), `${path} leaked index data in its 402`);
    }
  });
});

test("the 402 carries payment requirements a client can act on", async () => {
  await withServer(stubOracle(), async (get) => {
    const res = await get("/v1/index/latest", { headers: { accept: "application/json" } });
    assert.equal(res.status, 402);

    // x402 v2 puts requirements in a base64 `payment-required` header, not the body.
    const header = res.headers.get("payment-required");
    assert.ok(header, "402 must carry a payment-required header");
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));

    assert.equal(challenge.x402Version, 2);
    const accepts = challenge.accepts ?? [];
    assert.ok(accepts.length > 0, "402 must list at least one accepted payment method");
    assert.equal(accepts[0].scheme, "exact");
    assert.equal(accepts[0].network, "stellar:testnet");
    assert.equal(accepts[0].payTo, CONFIG.payTo);
    // $0.01 of a 7dp asset is 100000 base units; a wrong scale is a real bug.
    assert.equal(accepts[0].amount, "100000");
    assert.match(accepts[0].asset, /^C[A-Z2-7]{55}$/, "asset must be a Soroban contract id");
  });
});

test("every route in the price table is priced and paywalled", () => {
  const routes = buildRoutes(CONFIG);
  for (const [route, cfg] of Object.entries(routes)) {
    assert.match(cfg.accepts.price, /^\$\d/, `${route} has no dollar price`);
    assert.equal(cfg.accepts.network, CONFIG.caip2);
    assert.equal(cfg.accepts.payTo, CONFIG.payTo);
  }
});
