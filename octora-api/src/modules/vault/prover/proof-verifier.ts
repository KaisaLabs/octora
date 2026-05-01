import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snarkjs: any = await import("snarkjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = join(__dirname, "..", "circuits");

let verificationKey: unknown = null;

async function getVerificationKey(): Promise<unknown> {
  if (!verificationKey) {
    const raw = await readFile(
      join(CIRCUITS_DIR, "verification_key.json"),
      "utf-8",
    );
    verificationKey = JSON.parse(raw);
  }
  return verificationKey;
}

/** Paths to the compiled circuit artifacts needed for proof generation. */
export function getCircuitArtifactPaths() {
  return {
    wasm: join(CIRCUITS_DIR, "withdraw.wasm"),
    zkey: join(CIRCUITS_DIR, "withdraw.zkey"),
  };
}

/** Check if circuit artifacts exist (needed before proof generation). */
export async function circuitArtifactsExist(): Promise<boolean> {
  const { wasm, zkey } = getCircuitArtifactPaths();
  try {
    await Promise.all([
      readFile(wasm, { flag: "r" }),
      readFile(zkey, { flag: "r" }),
      readFile(join(CIRCUITS_DIR, "verification_key.json"), { flag: "r" }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a Groth16 proof for a withdrawal.
 * Requires compiled circuit artifacts (run setup.sh first).
 */
export async function generateWithdrawProof(
  inputs: Record<string, string | string[] | number[]>,
): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  const { wasm, zkey } = getCircuitArtifactPaths();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    wasm,
    zkey,
  );
  return { proof, publicSignals };
}

/**
 * Verify a Groth16 withdrawal proof off-chain.
 * Used as a fast sanity check before submitting the on-chain tx.
 */
export async function verifyWithdrawProof(
  proof: Groth16Proof,
  publicSignals: string[],
): Promise<boolean> {
  const vkey = await getVerificationKey();
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}
