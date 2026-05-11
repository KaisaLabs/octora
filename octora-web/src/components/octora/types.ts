export type LiquidityBin = {
  binId: number;
  price: number;
  liquidity: number;
};

export type Pool = {
  id: string;
  name: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  /** Solana mint addresses; empty string if unknown. */
  tokenAMint: string;
  tokenBMint: string;
  address: string;
  protocol: string;
  tvl: string;
  apr: string;
  volume24h: string;
  fees24h: string;
  /** Raw USD volume/fees by timeframe label ("5m"/"30m"/"1h"/"2h"/"4h"/"12h"/"24h").
   *  Backend forwards Meteora's full bucket map on mainnet; devnet only has
   *  `{ "24h": n }`. Used by the pool-list timeframe selector to swap which
   *  bucket drives display, sort, and Fee/TVL. */
  volumeByTf: Record<string, number>;
  feesByTf: Record<string, number>;
  strategy: string;
  depth: string;
  risk: string;
  feeBps: number;
  binStep: number;
  /** Unix seconds; 0 if unknown. */
  createdAt: number;
  binRange: string;
  priceRange: string;
  activeBinId: number;
  activePrice: number;
  allocation: {
    tokenA: number;
    tokenB: number;
  };
  tags: string[];
};

export type DistributionShape = "spot" | "curve" | "bid-ask";

export type PortfolioPosition = {
  id: string;
  /** LB pair address — needed by the Claim/Withdraw lifecycle. */
  poolAddress: string;
  /** Stealth pubkey that owns the on-chain position. Surfaced to the UI so
   *  it can read the wallet balance for the post-close sweep flow. */
  stealthPubkey?: string;
  /** Stealth-derivation scheme for this position. Threaded into the
   *  private-claim / private-exit modals so they pick the right derive
   *  function. Missing or "v1" = per-pool legacy; "v2" = per-position. */
  derivationVersion?: "v1" | "v2";
  /** True after `runWithdrawClose` settles. Position no longer exists on-chain
   *  but funds may still be sitting at `stealthPubkey` waiting to be swept. */
  closed?: boolean;
  poolName: string;
  protocol: string;
  deposited: string;
  value: string;
  feesEarned: string;
  /** Raw USD amounts — display strings above are locale-formatted and not
   *  safe to re-parse for arithmetic (comma-decimal locales break parseFloat).
   *  Use these for any math; use the strings only for rendering. */
  depositedUsd?: number;
  valueUsd?: number;
  feesUsd?: number;
  apr: string;
  status: string;
  /** Bin id boundaries of the LP range. */
  rangeLowerBin?: number;
  rangeUpperBin?: number;
  activeBinId?: number;
  binStep?: number;
  /** Current on-chain price at the active bin (quote per base). Joined in
   *  from the Pool record at portfolio-hook time so the position detail
   *  chart can label bin prices with the same DLMM formula the pool detail
   *  page uses, instead of a synthetic placeholder. */
  activePrice?: number;
  shape?: DistributionShape;
  inRange?: boolean;
  claimable?: string;
  /** True when the on-chain position has non-zero raw `feeX`/`feeY` lamports.
   *  Independent of USD pricing — devnet pools rarely have Jupiter prices, so
   *  `claimable` reads "$0.00" even when fees have actually accrued. The
   *  Claim button gates on this flag so the user can still trigger the tx. */
  hasClaimableFees?: boolean;
  pnl?: string;
  pnlDirection?: "up" | "down" | "flat";
  openedAt?: string;
};

export type ActivityKind = "deposit" | "withdraw" | "claim" | "rebalance";

export type PortfolioActivity = {
  id: string;
  action: string;
  kind: ActivityKind;
  poolName: string;
  value: string;
  /** ISO timestamp; if omitted, falls back to `time`. */
  timestamp?: string;
  time: string;
  privacy: string;
  txSignature?: string;
};
