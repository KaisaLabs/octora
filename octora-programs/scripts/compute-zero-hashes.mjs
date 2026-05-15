/**
 * Compute the Poseidon zero hashes for a 20-level Merkle tree.
 * These must match both circomlibjs (off-chain) and light-poseidon (on-chain).
 *
 * ZERO_VALUE = 0
 * ZERO_HASHES[0] = Poseidon(0, 0)
 * ZERO_HASHES[i] = Poseidon(ZERO_HASHES[i-1], ZERO_HASHES[i-1])
 *
 * Output: Rust constants as big-endian [u8; 32] arrays.
 */

import { buildPoseidon } from "circomlibjs";

const TREE_LEVELS = 20;

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const zeroHashes = [];
  let current = BigInt(0); // ZERO_VALUE

  console.log("// Computed with circomlibjs Poseidon (BN254)");
  console.log("// ZERO_VALUE = 0");
  console.log("");

  // Also output the initial root (what the empty tree root is)
  // For fixed-merkle-tree with zeroElement="0", the initial root
  // is computed by hashing up from 0 through all levels
  let rootHash = current;

  for (let i = 0; i < TREE_LEVELS; i++) {
    const hash = poseidon([F.e(current), F.e(current)]);
    const hashBigInt = BigInt(F.toString(hash));
    zeroHashes.push(hashBigInt);

    // Convert to big-endian 32-byte hex
    const hexStr = hashBigInt.toString(16).padStart(64, "0");
    const bytes = [];
    for (let j = 0; j < 64; j += 2) {
      bytes.push(`0x${hexStr.slice(j, j + 2)}`);
    }

    console.log(`    // ZERO_HASHES[${i}] = Poseidon(${i === 0 ? "0, 0" : `ZERO_HASHES[${i - 1}], ZERO_HASHES[${i - 1}]`})`);
    console.log(`    // = ${hashBigInt}`);
    console.log(`    [${bytes.join(", ")}],`);
    console.log("");

    current = hashBigInt;
  }

  // The initial root of an empty 20-level tree
  console.log("// ============================================");
  console.log(`// Initial empty tree root (ZERO_HASHES[${TREE_LEVELS - 1}]):`);
  console.log(`// ${current}`);
  console.log("// ============================================");

  // Also verify against fixed-merkle-tree
  console.log("\n// Verification: computing empty tree root via fixed-merkle-tree...");

  // Import and build tree to verify
  const { default: MerkleTree } = await import("fixed-merkle-tree");
  const hashFn = (left, right) => {
    const result = poseidon([BigInt(left), BigInt(right)]);
    return F.toString(result);
  };
  const tree = new MerkleTree(TREE_LEVELS, [], {
    hashFunction: hashFn,
    zeroElement: "0",
  });

  const treeRoot = BigInt(tree.root);
  console.log(`// fixed-merkle-tree root: ${treeRoot}`);
  console.log(`// ZERO_HASHES[19]:       ${current}`);
  console.log(`// Match: ${treeRoot === current}`);
}

main().catch(console.error);
