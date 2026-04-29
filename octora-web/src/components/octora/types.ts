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
  binRange: string;
  priceRange: string;
  allocation: {
    tokenA: number;
    tokenB: number;
  };
  tags: string[];
};

export type PortfolioPosition = {
  id: string;
  poolName: string;
  protocol: string;
  deposited: string;
  value: string;
  feesEarned: string;
  apr: string;
  status: string;
};

export type PortfolioActivity = {
  id: string;
  action: string;
  poolName: string;
  value: string;
  time: string;
  privacy: string;
};
