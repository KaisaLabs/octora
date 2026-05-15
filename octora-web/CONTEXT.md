# Web Client

React + Vite UI for Octora. Wallet-gated. Talks to the Backend over HTTP REST. Runs the user-side cryptography (`signMessage`, **Encrypted Seed** encrypt/decrypt) — secret material never leaves the client.

Most domain language comes from the Backend. See the [backend glossary](../octora-api/CONTEXT.md) for **Position**, **Stealth Wallet**, **Encrypted Seed**, **Execution Mode**, **Mode Fallback**, **Safe Next Step**, etc.

## Language

This client adds:

**Pool Browser**:
The UI surface for discovering Meteora DLMM pools. Backed by the API's DLMM proxy.
_Avoid_: Pool list, market screen

**Strategy Setup**:
The form that turns a user's pool selection into a Position request — bin range, deposit denomination, execution mode.
_Avoid_: Order form, deposit form

**Wallet Gating**:
The route-level wallet-connect requirement. Most of the app is hidden until a wallet is connected.

**Denomination Picker**:
The UI phase (in `PrivateDepositModal` and/or the pool detail page) where the user explicitly chooses which Mixer Pool **Denomination** tier to deposit into. The denomination is never auto-derived from a target deposit amount — multi-denom is a user-facing choice.
_Avoid_: Amount picker

## Relationships

- A **Pool Browser** selection feeds **Strategy Setup**.
- A **Strategy Setup** submission creates one **Position** on the backend.

## Flagged ambiguities

- README mentions a standalone `octora-waitlist` surface; the current `octora-web/` is the dashboard app. They are not the same project.
