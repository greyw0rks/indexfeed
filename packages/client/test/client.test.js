import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndexFeedClient, createPayingFetch, NETWORK_CAIP2 } from "../src/index.js";

// A funded testnet keypair is not needed to construct a signer, so these tests
// cover configuration and validation without touching the network. This key is
// randomly generated, holds nothing, and exists only to satisfy the signer.
const SECRET = "SD2PPIRDUYPODHS3AICM2R5PHVII2XU57JGQTJYLQ53OGRS2SUC62IOZ";

test("rejects a client with no wallet", () => {
  assert.throws(() => createPayingFetch({ secretKey: undefined }), /secret key is required/);
});

test("rejects an unknown network", () => {
  assert.throws(() => createPayingFetch({ secretKey: SECRET, network: "mainnet" }), /unknown network/);
});

test("network names map to CAIP-2 identifiers the server also uses", () => {
  assert.equal(NETWORK_CAIP2.testnet, "stellar:testnet");
  assert.equal(NETWORK_CAIP2.pubnet, "stellar:pubnet");
});

test("requires a baseUrl", () => {
  assert.throws(() => createIndexFeedClient({ secretKey: SECRET }), /baseUrl is required/);
});

test("describe reads the free endpoint without a wallet in play", async () => {
  const server = (await import("node:http")).createServer((req, res) => {
    assert.equal(req.url, "/");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "IndexFeed", routes: [] }));
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const c = createIndexFeedClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      secretKey: SECRET,
    });
    assert.equal((await c.describe()).service, "IndexFeed");
  } finally {
    server.close();
  }
});

test("a trailing slash in baseUrl does not produce a double slash", async () => {
  const seen = [];
  const server = (await import("node:http")).createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const c = createIndexFeedClient({
      baseUrl: `http://127.0.0.1:${server.address().port}/`,
      secretKey: SECRET,
    });
    await c.latest();
    assert.deepEqual(seen, ["/v1/index/latest"]);
  } finally {
    server.close();
  }
});
