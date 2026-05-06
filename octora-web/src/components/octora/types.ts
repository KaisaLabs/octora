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
  address: string;
  protocol: string;
  tvl: string;
  apr: string;
  volume24h: string;
  fees24h: string;
  strategy: string;
  depth: string;
  risk: string;
  feeBps: number;
  binStep: number;
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
  poolName: string;
  protocol: string;
  deposited: string;
  value: string;
  feesEarned: string;
  apr: string;
  status: string;
  /** Bin id boundaries of the LP range. */
  rangeLowerBin?: number;
  rangeUpperBin?: number;
  activeBinId?: number;
  binStep?: number;
  shape?: DistributionShape;
  inRange?: boolean;
  claimable?: string;
  pnl?: string;
  pnlDirection?: "up" | "down" | "flat";
  openedAt?: string;
};

export type PortfolioActivity = {
  id: string;
  action: string;
  poolName: string;
  value: string;
  time: string;
  privacy: string;
};
