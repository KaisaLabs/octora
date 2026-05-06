import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { LiquidityBin, Pool } from "@/components/octora/types";
import { getPoolBins } from "@/lib/api";
import { synthesizeBins } from "@/lib/bins";

export interface UsePoolBinsResult {
  bins: LiquidityBin[];
  activeBinId: number;
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
}

/**
 * Fetch on-chain bin liquidity for a DLMM pool. While loading or on error,
 * fall back to a deterministic synthetic distribution so the UI never goes blank.
 */
export function usePoolBins(pool: Pool, count = 61): UsePoolBinsResult {
  const synthetic = useMemo(() => synthesizeBins(pool, { count }), [pool, count]);
  const syntheticActive = synthetic[Math.floor(synthetic.length / 2)]?.binId ?? 0;

  const query = useQuery({
    queryKey: ["pool-bins", pool.address, count],
    queryFn: () => getPoolBins(pool.address, { network: "mainnet", count }),
    enabled: Boolean(pool.address),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  if (query.data) {
    const bins: LiquidityBin[] = query.data.bins.map((b) => ({
      binId: b.binId,
      price: b.price,
      liquidity: b.liquidity,
    }));
    return {
      bins,
      activeBinId: query.data.activeBinId,
      isLoading: false,
      isFallback: false,
      error: null,
    };
  }

  return {
    bins: synthetic,
    activeBinId: syntheticActive,
    isLoading: query.isLoading,
    isFallback: !query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
