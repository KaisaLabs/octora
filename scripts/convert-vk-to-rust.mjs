/**
 * Convert snarkjs verification_key.json to Rust byte constants
 * for groth16-solana on-chain verification.
 *
 * Usage:
 *   node scripts/convert-vk-to-rust.mjs <path-to-verification_key.json>
 *
 * Output: Rust constants to paste into verifier/groth16.rs
 *
 * groth16-solana expects:
 * - G1 points: 64 bytes (x: 32 BE || y: 32 BE), NEGATED for alpha
 * - G2 points: 128 bytes (x_c1: 32 BE || x_c0: 32 BE || y_c1: 32 BE || y_c0: 32 BE)
 *
 * snarkjs VK format (JSON strings of decimal field elements):
 * - vk_alpha_1: [x, y, "1"] (affine G1)
 * - vk_beta_2: [[x_c0, x_c1], [y_c0, y_c1], ["1", "0"]] (affine G2)
 * - vk_gamma_2: same as beta
 * - vk_delta_2: same as beta
 * - IC: array of [x, y, "1"] (affine G1 points)
 */

import { readFileSync } from "fs";

const vkPath = process.argv[2];
if (!vkPath) {
  console.error("Usage: node convert-vk-to-rust.mjs <verification_key.json>");
  process.exit(1);
}

const vk = JSON.parse(readFileSync(vkPath, "utf8"));

/**
 * Convert a decimal string to big-endian 32-byte hex array
 */
function toBytes32(decStr) {
  const hex = BigInt(decStr).toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(`0x${hex.slice(i, i + 2)}`);
  }
  return bytes;
}

/**
 * Format bytes as Rust array literal, 8 bytes per line
 */
function formatBytes(bytes, indent = "    ") {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 8) {
    lines.push(indent + bytes.slice(i, i + 8).join(", ") + ",");
  }
  return lines.join("\n");
}

/**
 * Negate a G1 y-coordinate in the BN254 base field.
 * p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
 */
function negateG1Y(yDec) {
  const p = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
  const y = BigInt(yDec);
  return (p - y) % p;
}

// ── Alpha (G1, NOT negated — groth16-solana uses it as-is in the pairing) ──
const alphaX = toBytes32(vk.vk_alpha_1[0]);
const alphaY = toBytes32(vk.vk_alpha_1[1]);

console.log("/// vk.alpha_1 (G1 point, original — NOT negated)");
console.log("pub const VK_ALPHA: [u8; 64] = [");
console.log(formatBytes([...alphaX, ...alphaY]));
console.log("];");
console.log("");

// ── Beta (G2) ──
// snarkjs: [[x_c0, x_c1], [y_c0, y_c1]]
// groth16-solana: x_c1 || x_c0 || y_c1 || y_c0 (reversed coefficient order)
const betaX1 = toBytes32(vk.vk_beta_2[0][1]);
const betaX0 = toBytes32(vk.vk_beta_2[0][0]);
const betaY1 = toBytes32(vk.vk_beta_2[1][1]);
const betaY0 = toBytes32(vk.vk_beta_2[1][0]);

console.log("/// vk.beta_2 (G2 point)");
console.log("pub const VK_BETA: [u8; 128] = [");
console.log(formatBytes([...betaX1, ...betaX0, ...betaY1, ...betaY0]));
console.log("];");
console.log("");

// ── Gamma (G2) ──
const gammaX1 = toBytes32(vk.vk_gamma_2[0][1]);
const gammaX0 = toBytes32(vk.vk_gamma_2[0][0]);
const gammaY1 = toBytes32(vk.vk_gamma_2[1][1]);
const gammaY0 = toBytes32(vk.vk_gamma_2[1][0]);

console.log("/// vk.gamma_2 (G2 point)");
console.log("pub const VK_GAMMA: [u8; 128] = [");
console.log(formatBytes([...gammaX1, ...gammaX0, ...gammaY1, ...gammaY0]));
console.log("];");
console.log("");

// ── Delta (G2) ──
const deltaX1 = toBytes32(vk.vk_delta_2[0][1]);
const deltaX0 = toBytes32(vk.vk_delta_2[0][0]);
const deltaY1 = toBytes32(vk.vk_delta_2[1][1]);
const deltaY0 = toBytes32(vk.vk_delta_2[1][0]);

console.log("/// vk.delta_2 (G2 point)");
console.log("pub const VK_DELTA: [u8; 128] = [");
console.log(formatBytes([...deltaX1, ...deltaX0, ...deltaY1, ...deltaY0]));
console.log("];");
console.log("");

// ── IC (array of G1 points) ──
console.log(`/// vk.IC (${vk.IC.length} G1 points: 1 base + ${vk.IC.length - 1} public inputs)`);
console.log(`pub const VK_IC: [[u8; 64]; ${vk.IC.length}] = [`);
for (let i = 0; i < vk.IC.length; i++) {
  const x = toBytes32(vk.IC[i][0]);
  const y = toBytes32(vk.IC[i][1]);
  console.log(`    // IC[${i}]`);
  console.log("    [");
  console.log(formatBytes([...x, ...y], "        "));
  console.log("    ],");
}
console.log("];");

console.log("");
console.log(`// Number of public inputs: ${vk.IC.length - 1}`);
console.log(`// Protocol: ${vk.protocol}`);
console.log(`// Curve: ${vk.curve}`);
