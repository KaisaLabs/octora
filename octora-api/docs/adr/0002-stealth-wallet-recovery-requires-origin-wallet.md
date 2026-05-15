# Stealth Wallet recovery requires the origin wallet

The Encrypted Seed for a Stealth Wallet is encrypted with a key derived from the origin wallet's `signMessage()` over a fixed message. The **only** way to recover a Stealth Wallet — and therefore the only way to access funds in the DLMM Position it owns — is to re-sign the same message with the same origin wallet. There is no backend escrow, admin override, or passphrase-based fallback.

**Why:** Any recovery path that does not require the origin wallet would create a link between Octora-side identity (a backend account, a passphrase, an admin) and the Stealth Wallet, defeating the unlinkability guarantee that the mixer exists to provide.

**Consequence:** Losing the origin wallet means permanently losing the funds inside that Position's DLMM Position. The UI must surface this risk explicitly at Strategy Setup time and at any flow that creates an Encrypted Seed. Do not "fix" this by adding a fallback — the privacy model depends on it.
