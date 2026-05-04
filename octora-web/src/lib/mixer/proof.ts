// Browser-side ZK proof generation.
//
// snarkjs.groth16.fullProve runs the witness calculator + Groth16 prover
// entirely in the browser. The wasm and zkey are fetched from the web
// app's static asset directory (octora-web/public/circuits/) so neither
// the witness inputs nor the proving key ever touch the API server.

import type { MixerMerkleTree } from "./merkle-tree";

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface WithdrawProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
}

export interface BuildProofInputsArgs {
  tree: MixerMerkleTree;
  leafIndex: number;
  secret: bigint;
  nullifier: bigint;
  nullifierHash: bigint;
  recipientField: bigint;
  relayerField: bigint;
  fee: bigint;
}

export type WithdrawCircuitInput = {
  root: string;
  nullifierHash: string;
  recipient: string;
  relayer: string;
  fee: string;
  secret: string;
  nullifier: string;
  pathElements: string[];
  pathIndices: number[];
};

/**
 * Assemble the snarkjs input object from the browser-local tree state and
 * the user's secrets. Mirrors generateProofInputs in the API's vault module.
 */
export function buildWithdrawCircuitInput(args: BuildProofInputsArgs): WithdrawCircuitInput {
  const { pathElements, pathIndices } = args.tree.getProof(args.leafIndex);
  return {
    root: args.tree.root().toString(),
    nullifierHash: args.nullifierHash.toString(),
    recipient: args.recipientField.toString(),
    relayer: args.relayerField.toString(),
    fee: args.fee.toString(),
    secret: args.secret.toString(),
    nullifier: args.nullifier.toString(),
    pathElements,
    pathIndices,
  };
}

const DEFAULT_WASM_URL = "/circuits/withdraw.wasm";
const DEFAULT_ZKEY_URL = "/circuits/withdraw.zkey";

/**
 * Generate a Groth16 proof in the browser. Returns the proof and public
 * signals — both safe to send to the relayer / on-chain. The witness
 * (secret, nullifier, path) is consumed locally and discarded.
 *
 * Heavy operation: ~10–60s on consumer hardware depending on the device.
 */
export async function generateWithdrawProof(
  inputs: WithdrawCircuitInput,
  opts: { wasmUrl?: string; zkeyUrl?: string } = {},
): Promise<WithdrawProofResult> {
  const wasmUrl = opts.wasmUrl ?? DEFAULT_WASM_URL;
  const zkeyUrl = opts.zkeyUrl ?? DEFAULT_ZKEY_URL;

  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs as unknown as Parameters<typeof snarkjs.groth16.fullProve>[0],
    wasmUrl,
    zkeyUrl,
  );
  return { proof: proof as Groth16Proof, publicSignals };
}
