import { describe, it, expect, beforeEach } from "vitest";
import { RelayerService } from "../relayer.service.js";
import { InMemoryNullifierRegistry } from "../nullifier-registry.js";
import type { RelayerConfig, WithdrawRequest } from "../types.js";

const TEST_CONFIG: RelayerConfig = {
  baseFeelamports: 5000n,
  hotWalletSecret: "test-hot-wallet",
  rpcUrl: "http://localhost:8899",
  mixerProgramId: "MixerProgram111111111111111111111111111",
  poolDenomination: 1_000_000_000n, // 1 SOL
};

function createMockRequest(overrides: Partial<WithdrawRequest> = {}): WithdrawRequest {
  return {
    proof: {
      pi_a: ["1", "2"],
      pi_b: [["3", "4"], ["5", "6"]],
      pi_c: ["7", "8"],
      protocol: "groth16",
      curve: "bn128",
    },
    publicSignals: ["root-hash", "nullifier-hash-123", "recipient-addr", "relayer-addr", "5000"],
    root: "12345",
    nullifierHash: "nullifier-hash-123",
    recipient: "StealthWallet111111111111111111111111111",
    relayer: "test-hot-wallet",
    fee: "5000",
    ...overrides,
  };
}

describe("RelayerService", () => {
  let service: RelayerService;
  let nullifiers: InMemoryNullifierRegistry;

  beforeEach(() => {
    nullifiers = new InMemoryNullifierRegistry();
    service = new RelayerService(TEST_CONFIG, nullifiers);
  });

  describe("processWithdrawal", () => {
    it("rejects if nullifier already spent", async () => {
      await nullifiers.markSpent("nullifier-hash-123", "prev-tx-sig");

      const result = await service.processWithdrawal(createMockRequest());

      expect(result.success).toBe(false);
      expect(result.error).toContain("already spent");
    });

    it("rejects with invalid proof or missing circuit artifacts", async () => {
      const request = createMockRequest();
      const result = await service.processWithdrawal(request);

      // Without compiled circuit artifacts, proof verification throws.
      // This is expected in test — in prod, circuits are compiled via setup.sh.
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.nullifierHash).toBe("nullifier-hash-123");
    });
  });

  describe("validateProof", () => {
    it("rejects spent nullifiers", async () => {
      await nullifiers.markSpent("nullifier-hash-123", "prev-tx-sig");

      const result = await service.validateProof(createMockRequest());

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("already spent");
    });
  });

  describe("generateRecipientWallet", () => {
    it("generates unique stealth wallets", () => {
      const w1 = service.generateRecipientWallet();
      const w2 = service.generateRecipientWallet();

      expect(w1.publicKey).not.toBe(w2.publicKey);
      expect(w1.seed).not.toEqual(w2.seed);
    });

    it("generates valid Solana keypairs", () => {
      const wallet = service.generateRecipientWallet();

      expect(wallet.publicKey).toHaveLength(44); // base58 pubkey length (approx)
      expect(wallet.keypair).toBeDefined();
      expect(wallet.seed).toHaveLength(32);
    });
  });

  describe("status", () => {
    it("returns operational metrics", async () => {
      const status = await service.status();

      expect(status.pendingWithdrawals).toBe(0);
      expect(status.totalProcessed).toBe(0);
      expect(status.nullifierCount).toBe(0);
    });
  });
});
