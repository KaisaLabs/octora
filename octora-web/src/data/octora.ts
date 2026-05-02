import { PortfolioActivity, PortfolioPosition } from "@/components/octora/types";

export const portfolioPositions: PortfolioPosition[] = [
  {
    id: "pos-1",
    poolName: "SOL / USDC",
    protocol: "Meteora DLMM",
    deposited: "$92,000",
    value: "$104,340",
    feesEarned: "$8,190",
    apr: "28.4%",
    status: "In range",
  },
  {
    id: "pos-2",
    poolName: "JUP / SOL",
    protocol: "Meteora DAMM",
    deposited: "$61,500",
    value: "$66,270",
    feesEarned: "$5,012",
    apr: "31.7%",
    status: "Monitoring",
  },
  {
    id: "pos-3",
    poolName: "PYTH / USDC",
    protocol: "Meteora DAMM",
    deposited: "$48,000",
    value: "$49,910",
    feesEarned: "$2,846",
    apr: "22.9%",
    status: "In range",
  },
];

export const portfolioActivity: PortfolioActivity[] = [
  {
    id: "act-1",
    action: "Private deposit",
    poolName: "SOL / USDC",
    value: "$28,000",
    time: "4 min ago",
    privacy: "Origin hidden",
  },
  {
    id: "act-2",
    action: "Range rebalance",
    poolName: "JUP / SOL",
    value: "$12,400",
    time: "43 min ago",
    privacy: "Routed privately",
  },
  {
    id: "act-3",
    action: "Fee claim",
    poolName: "PYTH / USDC",
    value: "$1,180",
    time: "2 hr ago",
    privacy: "Shielded settlement",
  },
];
