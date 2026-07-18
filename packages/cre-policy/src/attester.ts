import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {abis} from "@bankos/shared/abis";
import {chainById, supportsCRE, type Deployment, type Policy} from "@bankos/shared";

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * The local DON / attester. In production the equivalent on-chain write is performed by the
 * Chainlink CRE workflow via `evm.writeReport → PolicyRegistry.onReport`. Locally we sign and
 * submit `PolicyRegistry.attest()` with the attester key (authorized in the registry at deploy),
 * producing a genuine on-chain state change that gates the banks.
 */
export class Attester {
  readonly deployment: Deployment;
  private readonly wallet;
  private readonly publicClient;
  readonly account;

  constructor() {
    const chainId = Number(process.env.CHAIN_ID ?? 31337);
    const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
    const chain = chainById(chainId);

    // Chainlink CRE is Arc-only. Refuse to stand up the attester on a chain where CRE isn't available
    // (e.g. Robinhood Chain) — the confidential-compliance layer must not silently pretend to run there.
    if (!supportsCRE(chainId)) {
      throw new Error(
        `[cre-policy] Chainlink CRE is not available on chain ${chainId} (${chain.name}); CRE attestation is Arc-only`,
      );
    }

    // Fail fast on a real chain: never sign Arc attestations with the local anvil fallback key / localhost RPC.
    if (chainId !== 31337 && (!process.env.ATTESTER_PRIVATE_KEY || !process.env.RPC_URL)) {
      throw new Error(`[cre-policy] chainId ${chainId} requires ATTESTER_PRIVATE_KEY and RPC_URL to be set — refusing anvil defaults`);
    }

    const depPath =
      process.env.DEPLOYMENT_PATH ??
      join(__dir, "..", "..", "contracts", "deployments", `${chainId}.json`);
    this.deployment = JSON.parse(readFileSync(depPath, "utf8")) as Deployment;

    // anvil account #1 is the default attester wired in Deploy.s.sol.
    const pk = (process.env.ATTESTER_PRIVATE_KEY ??
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
    this.account = privateKeyToAccount(pk);

    this.wallet = createWalletClient({account: this.account, chain, transport: http(rpcUrl)});
    this.publicClient = createPublicClient({chain, transport: http(rpcUrl)});
  }

  get registry(): Address {
    return this.deployment.policyRegistry;
  }

  /** Land a compliance attestation on-chain. Returns the tx hash. */
  async attest(bank: Address, member: Address, policy: Policy): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.registry,
      abi: abis.PolicyRegistry,
      functionName: "attest",
      args: [
        bank,
        member,
        {
          tier: policy.tier,
          canDeposit: policy.canDeposit,
          canBorrow: policy.canBorrow,
          jurisdiction: policy.jurisdiction,
          expiry: BigInt(policy.expiry),
        },
      ],
    });
    await this.publicClient.waitForTransactionReceipt({hash});
    return hash;
  }

  /** Revoke a member's attestation (e.g. on a sanctions re-screen hit). */
  async revoke(bank: Address, member: Address): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.registry,
      abi: abis.PolicyRegistry,
      functionName: "revoke",
      args: [bank, member],
    });
    await this.publicClient.waitForTransactionReceipt({hash});
    return hash;
  }

  async getPolicy(bank: Address, member: Address) {
    const p = (await this.publicClient.readContract({
      address: this.registry,
      abi: abis.PolicyRegistry,
      functionName: "getPolicy",
      args: [bank, member],
    })) as {tier: number; canDeposit: boolean; canBorrow: boolean; jurisdiction: Hex; expiry: bigint};
    return {
      tier: Number(p.tier),
      canDeposit: p.canDeposit,
      canBorrow: p.canBorrow,
      jurisdiction: p.jurisdiction,
      expiry: Number(p.expiry),
    };
  }
}
