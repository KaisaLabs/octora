export interface DailyPnL {
  /** ISO date (YYYY-MM-DD), local time. */
  date: string;
  pnlUsd: number;
  positions: number;
}

export interface PnLSummary {
  totalDeposited: number;
  feesClaimed: number;
  claimableFees: number;
  totalPositionValue: number;
  totalPnL: number;
  totalPnLPct: number;
  avgInvested: number;
  winRate: number;
  biggestWinUsd: number;
  biggestWinPct: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Build a deterministic per-day PnL series ending at `until` (inclusive).
 * Days before `since` (e.g. position open date) yield no data.
 */
export function generateDailyPnL(opts: {
  since: Date;
  until: Date;
  seed?: number;
  dailyMeanUsd?: number;
}): DailyPnL[] {
  const { since, until } = opts;
  const seed = opts.seed ?? 0xb1a5;
  const mean = opts.dailyMeanUsd ?? 12;
  const rng = mulberry32(seed);
  const out: DailyPnL[] = [];

  const cur = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  const last = new Date(until.getFullYear(), until.getMonth(), until.getDate());
  while (cur <= last) {
    // Mostly small wins, occasional big day, rare losing day.
    const r = rng();
    let pnl: number;
    if (r < 0.08) pnl = -mean * (0.4 + rng() * 0.8);
    else if (r > 0.92) pnl = mean * (2 + rng() * 4);
    else pnl = mean * (0.3 + rng() * 1.4);
    pnl = Math.round(pnl * 100) / 100;

    const positions = 1 + Math.floor(rng() * 3);
    out.push({ date: isoLocal(cur), pnlUsd: pnl, positions });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Build a synthetic per-hour fees / IL / price-drift breakdown for one position.
 * Used to feed PnLBreakdownChart until the indexer exposes a real series.
 */
export function generatePositionPnLSeries(opts: {
  hours?: number;
  seed?: number;
  notionalUsd: number;
  apr: number;
  volatility?: number;
}): { t: number; fees: number; il: number; price: number }[] {
  const hours = opts.hours ?? 24 * 30;
  const rng = mulberry32(opts.seed ?? 0xfeed);
  const ratePerHour = (opts.notionalUsd * opts.apr) / 100 / (24 * 365);
  const sigma = opts.volatility ?? 0.04;

  let logPrice = 0;
  let fees = 0;
  let priceContribution = 0;
  const out: { t: number; fees: number; il: number; price: number }[] = [];

  for (let h = 0; h <= hours; h++) {
    fees += ratePerHour * (0.7 + rng() * 0.6);
    // GBM-ish per-hour log return.
    const dW = (rng() * 2 - 1) * sigma * Math.sqrt(1 / 24);
    logPrice += dW - 0.5 * sigma * sigma * (1 / 24);
    const ratio = Math.exp(logPrice);
    // Price contribution: signed, scales with notional.
    priceContribution = opts.notionalUsd * (ratio - 1);
    // IL ≈ -0.5 * notional * (1 - sqrt(ratio))^2 / sqrt(ratio). Always non-positive.
    const il = priceContribution !== 0 ? -opts.notionalUsd * 0.5 * Math.pow(1 - Math.sqrt(ratio), 2) / Math.sqrt(ratio) : 0;
    out.push({ t: h, fees, il: Number.isFinite(il) ? il : 0, price: priceContribution });
  }
  return out;
}

export function summarizePnL(daily: DailyPnL[], opts: { totalDeposited: number; totalPositionValue: number; feesClaimed: number; claimableFees: number }): PnLSummary {
  const totalPnL = daily.reduce((s, d) => s + d.pnlUsd, 0);
  const totalPnLPct = opts.totalDeposited > 0 ? (totalPnL / opts.totalDeposited) * 100 : 0;
  const avgInvested = opts.totalDeposited / Math.max(1, daily.length / 30);
  const wins = daily.filter((d) => d.pnlUsd > 0).length;
  const winRate = daily.length > 0 ? (wins / daily.length) * 100 : 0;
  const biggest = daily.reduce<DailyPnL | null>((best, d) => (!best || d.pnlUsd > best.pnlUsd ? d : best), null);
  const biggestWinUsd = biggest?.pnlUsd ?? 0;
  const biggestWinPct = opts.totalDeposited > 0 ? (biggestWinUsd / opts.totalDeposited) * 100 : 0;

  return {
    totalDeposited: opts.totalDeposited,
    feesClaimed: opts.feesClaimed,
    claimableFees: opts.claimableFees,
    totalPositionValue: opts.totalPositionValue,
    totalPnL,
    totalPnLPct,
    avgInvested,
    winRate,
    biggestWinUsd,
    biggestWinPct,
  };
}
