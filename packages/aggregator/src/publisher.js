/**
 * Oracle publisher — submits a computed epoch to the Soroban contract.
 *
 * The publishing key is the only key with write access to the contract and is
 * held server-side only. It is deliberately distinct from the x402 facilitator
 * key used by the API, so compromising the paid endpoint cannot forge an index
 * update.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export const NETWORKS = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
  },
  // Mainnet has no public RPC; a provider URL must be supplied.
  pubnet: {
    passphrase: Networks.PUBLIC,
    rpcUrl: null,
  },
};

/** How long to wait for a submitted transaction to leave PENDING. */
const CONFIRM_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export function resolveNetwork(network, rpcUrlOverride) {
  const preset = NETWORKS[network];
  if (!preset) throw new Error(`unknown network ${network}; expected testnet or pubnet`);
  const rpcUrl = rpcUrlOverride ?? preset.rpcUrl;
  if (!rpcUrl) {
    throw new Error(`network ${network} requires an explicit RPC URL (set STELLAR_RPC_URL)`);
  }
  return { passphrase: preset.passphrase, rpcUrl };
}

export function createServer(network, rpcUrlOverride) {
  const { rpcUrl, passphrase } = resolveNetwork(network, rpcUrlOverride);
  return { server: new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") }), passphrase };
}

/**
 * Encode a constituent list as the contract's `Vec<Constituent>`.
 *
 * A Soroban struct is a map whose *keys are symbols*, in sorted order.
 * `nativeToScVal` on a plain JS object encodes the keys as strings instead,
 * which the host rejects with `Error(Value, UnexpectedType)` at unpack time — so
 * the entries are built explicitly here.
 */
function constituentsToScVal(constituents) {
  const field = (name, val) =>
    new xdr.ScMapEntry({ key: nativeToScVal(name, { type: "symbol" }), val });

  return xdr.ScVal.scvVec(
    constituents.map((c) =>
      xdr.ScVal.scvMap([
        // Sorted by field name: `symbol` before `weight_bps`.
        field("symbol", nativeToScVal(c.symbol, { type: "symbol" })),
        field("weight_bps", nativeToScVal(c.weight_bps, { type: "u32" })),
      ]),
    ),
  );
}

/**
 * Build, sign, submit, and confirm a contract invocation.
 *
 * Simulation runs first so a rejection (bad epoch, unnormalized weights) is
 * surfaced without spending a fee.
 */
async function invoke({ server, passphrase, keypair, contractId, method, args }) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`simulation failed for ${method}: ${simulated.error}`);
  }

  const prepared = rpc.assembleTransaction(tx, simulated).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected on submit: ${JSON.stringify(sent.errorResult)}`);
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let result = await server.getTransaction(sent.hash);
  while (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    result = await server.getTransaction(sent.hash);
  }
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${method} did not confirm: status ${result.status}`);
  }

  return { hash: sent.hash, returnValue: result.returnValue };
}

/** Read-only call: simulate and decode, no fee, no signature. */
async function read({ server, passphrase, contractId, method, args = [], sourceAccount }) {
  const account = await server.getAccount(sourceAccount);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`read ${method} failed: ${simulated.error}`);
  }
  return scValToNative(simulated.result.retval);
}

export function createPublisher({ secretKey, contractId, network = "testnet", rpcUrl }) {
  if (!secretKey) throw new Error("publisher secret key is required");
  if (!contractId) throw new Error("oracle contract id is required");

  const keypair = Keypair.fromSecret(secretKey);
  const { server, passphrase } = createServer(network, rpcUrl);
  const ctx = { server, passphrase, keypair, contractId };

  return {
    publicKey: keypair.publicKey(),

    /** Initialize a freshly deployed contract. */
    async initialize(adminPublicKey, publisherPublicKey = keypair.publicKey()) {
      return invoke({
        ...ctx,
        method: "initialize",
        args: [
          new Address(adminPublicKey).toScVal(),
          new Address(publisherPublicKey).toScVal(),
        ],
      });
    },

    /** Publish epoch N. Fails on-chain unless N is exactly head + 1. */
    async publish({ epoch, value, constituents, methodologyHash }) {
      const hashBytes = Buffer.from(methodologyHash, "hex");
      if (hashBytes.length !== 32) {
        throw new Error(`methodology hash must be 32 bytes, got ${hashBytes.length}`);
      }
      return invoke({
        ...ctx,
        method: "publish",
        args: [
          nativeToScVal(epoch, { type: "u32" }),
          nativeToScVal(BigInt(value), { type: "i128" }),
          constituentsToScVal(constituents),
          xdr.ScVal.scvBytes(hashBytes),
        ],
      });
    },

    /** Current head epoch, or null before the first publish. */
    async head() {
      try {
        return await read({ ...ctx, method: "head", sourceAccount: keypair.publicKey() });
      } catch (err) {
        // NoData (error 3) is the expected pre-inception state, not a failure.
        if (String(err.message).includes("Error(Contract, #3)")) return null;
        throw err;
      }
    },

    async latest() {
      return read({ ...ctx, method: "latest", sourceAccount: keypair.publicKey() });
    },
  };
}

/** Reader with no signing key — what the API layer uses. */
export function createReader({ contractId, network = "testnet", rpcUrl, sourceAccount }) {
  if (!contractId) throw new Error("oracle contract id is required");
  if (!sourceAccount) throw new Error("a funded source account is required for simulation");
  const { server, passphrase } = createServer(network, rpcUrl);
  const ctx = { server, passphrase, contractId, sourceAccount };

  return {
    async latest() {
      return read({ ...ctx, method: "latest" });
    },
    async value() {
      return read({ ...ctx, method: "value" });
    },
    async atEpoch(epoch) {
      return read({ ...ctx, method: "at_epoch", args: [nativeToScVal(epoch, { type: "u32" })] });
    },
    async head() {
      return read({ ...ctx, method: "head" });
    },
  };
}
