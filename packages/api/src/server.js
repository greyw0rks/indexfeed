/**
 * IndexFeed x402-metered API.
 *
 * Payment is the access control: there are no API keys and no accounts. The
 * paid routes are gated by `@x402/express`, which returns 402 with payment
 * requirements until a valid payment is presented, then settles via the
 * facilitator. Free routes are limited to service metadata and health, which
 * carry no index data.
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { loadApiConfig } from "./config.js";
import { createOracleService } from "./oracle.js";

/** Paid routes and their prices. Everything else is free metadata. */
export function buildRoutes(config) {
  const accepts = (price) => ({
    accepts: { scheme: "exact", price, network: config.caip2, payTo: config.payTo },
  });
  return {
    "GET /v1/index/latest": {
      ...accepts(config.prices.latest),
      description: "Current index level, constituents, and weights from the oracle contract",
    },
    "GET /v1/index/value": {
      ...accepts(config.prices.value),
      description: "Current index level only",
    },
    "GET /v1/index/epoch/*": {
      ...accepts(config.prices.history),
      description: "A historical rebalance epoch",
    },
  };
}

export function createApp(config, oracle = createOracleService(config)) {
  const app = express();
  app.disable("x-powered-by");

  // Service description. Free on purpose: a client needs to see the price and
  // network before it can decide to pay, and this leaks no index data.
  app.get("/", (_req, res) => {
    res.json({
      service: "IndexFeed",
      description: "On-chain crypto index oracle on Stellar / Soroban, metered with x402",
      network: config.caip2,
      contractId: config.contractId,
      payment: { protocol: "x402", scheme: "exact", asset: "USDC", facilitator: config.facilitatorUrl },
      routes: Object.entries(buildRoutes(config)).map(([route, cfg]) => ({
        route,
        price: cfg.accepts.price,
        description: cfg.description,
      })),
    });
  });

  // Liveness only — deliberately does not touch RPC, so it stays truthful about
  // the process even when the network is unreachable.
  app.get("/health", (_req, res) => res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) }));

  app.use(
    paymentMiddlewareFromConfig(
      buildRoutes(config),
      new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
      [{ network: config.caip2, server: new ExactStellarScheme() }],
    ),
  );

  app.get("/v1/index/latest", async (_req, res, next) => {
    try {
      res.json(await oracle.latest());
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/index/value", async (_req, res, next) => {
    try {
      res.json(await oracle.value());
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/index/epoch/:epoch", async (req, res, next) => {
    const epoch = Number(req.params.epoch);
    if (!Number.isInteger(epoch) || epoch < 0) {
      return res.status(400).json({ error: "epoch must be a non-negative integer" });
    }
    try {
      res.json(await oracle.atEpoch(epoch));
    } catch (err) {
      next(err);
    }
  });

  // Contract errors are mapped to status codes; anything else is a 502, since
  // the failure is between the API and the chain rather than in the request.
  app.use((err, _req, res, _next) => {
    const message = String(err?.message ?? err);
    if (message.includes("Error(Contract, #3)")) {
      return res.status(503).json({ error: "no index update has been published yet" });
    }
    if (message.includes("Error(Contract, #8)")) {
      return res.status(404).json({ error: "epoch not found" });
    }
    console.error("upstream read failed:", message);
    res.status(502).json({ error: "oracle read failed" });
  });

  return app;
}

// Only start a listener when run directly, so tests can import `createApp`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadApiConfig();
  createApp(config).listen(config.port, () => {
    console.log(`IndexFeed API on :${config.port}  network ${config.caip2}`);
    console.log(`contract ${config.contractId}  payTo ${config.payTo}`);
    console.log(`facilitator ${config.facilitatorUrl}`);
  });
}
