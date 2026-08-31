/**
 * Reference client CLI — the end-to-end proof that a stranger with a funded
 * wallet can read the index with no account and no API key.
 *
 *   node src/cli.js describe
 *   node src/cli.js latest
 *   node src/cli.js value
 *   node src/cli.js epoch 3
 */
import { loadEnv } from "@indexfeed/aggregator/env";
import { createIndexFeedClient } from "./index.js";

loadEnv(process.cwd());

const baseUrl = process.env.INDEXFEED_API_URL ?? "http://localhost:3001";

function client() {
  return createIndexFeedClient({
    baseUrl,
    secretKey: process.env.CLIENT_SECRET_KEY,
    network: process.env.STELLAR_NETWORK ?? "testnet",
    rpcUrl: process.env.STELLAR_RPC_URL,
    maxPricePerRequest: process.env.MAX_PRICE_PER_REQUEST ?? "$0.05",
  });
}

function report({ data, settlement }) {
  console.log(JSON.stringify(data, null, 2));
  if (settlement) {
    console.log(`\npaid — settled in tx ${settlement.transaction ?? "(hash not reported)"}`);
  } else {
    console.warn("\nwarning: response carried no settlement proof");
  }
}

const [command, arg] = process.argv.slice(2);
const commands = {
  describe: async () => console.log(JSON.stringify(await client().describe(), null, 2)),
  latest: async () => report(await client().latest()),
  value: async () => report(await client().value()),
  epoch: async () => {
    if (arg === undefined) throw new Error("usage: cli.js epoch <n>");
    report(await client().atEpoch(Number(arg)));
  },
};

const run = commands[command];
if (!run) {
  console.error(`usage: cli.js <${Object.keys(commands).join("|")}> [arg]`);
  console.error(`api: ${baseUrl}`);
  process.exit(1);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
