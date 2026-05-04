// Public surface of the browser-side mixer crypto.
//
// Everything in here runs in the user's browser. Secrets, nullifiers, the
// stealth wallet's private key, and witness inputs to the proof never leave
// the device. The server only sees public values: commitments, the public
// merkle root, packed proof bytes, packed public-input bytes.

export { generateCommitment, type Commitment } from "./commitment";
export {
  createMixerMerkleTree,
  TREE_LEVELS,
  type MixerMerkleTree,
  type MerkleProof,
} from "./merkle-tree";
export {
  generateStealthWallet,
  recoverStealthWallet,
  encryptSeed,
  decryptSeed,
  type StealthWallet,
  type EncryptedSeed,
} from "./stealth-wallet";
export {
  convertProofToBytes,
  convertPublicInputsToBytes,
  pubkeyToFieldElement,
  pubkeyToFieldHash,
  uint8ArrayToBase64,
  type Groth16Proof,
} from "./bytes";
export {
  buildWithdrawCircuitInput,
  generateWithdrawProof,
  type WithdrawCircuitInput,
  type WithdrawProofResult,
  type BuildProofInputsArgs,
} from "./proof";
export { initPoseidon, poseidonHash } from "./poseidon";
