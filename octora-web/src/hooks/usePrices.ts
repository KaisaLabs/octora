import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getPrices, type PriceInfo, type PriceMap } from "@/lib/api";

const POLL_MS = 5_000;

interface UsePricesOptions {
  /** Disable polling/fetching entirely. Use when no mints are needed. */
  enabled?: boolean;
  /** Override the polling interval (ms). Set to `false` to fetch once. */
  refetchInterval?: number | false;
}

/**
 * Polls Jupiter-backed USD prices for a set of mints. Empty/undefined mints
 * are filtered out and never trigger a fetch.
 */
export function usePrices(mints: Array<string | undefined | null>, opts: UsePricesOptions = {}) {
  const { enabled = true, refetchInterval = POLL_MS } = opts;

  // Stable, sorted, deduped key so re-renders with same mints don't refetch.
  const ids = useMemo(() => {
    const set = new Set<string>();
    for (const m of mints) {
      if (typeof m === "string" && m.length >= 32) set.add(m);
    }
    return [...set].sort();
  }, [mints]);

  const query = useQuery<PriceMap>({
    queryKey: ["prices", ids],
    queryFn: () => getPrices(ids),
    enabled: enabled && ids.length > 0,
    refetchInterval: refetchInterval === false ? false : refetchInterval,
    // Keep showing the prior tick while a refetch is in flight to avoid flicker.
    placeholderData: (prev) => prev,
    staleTime: POLL_MS,
  });

  return query;
}

export function usePrice(mint: string | undefined | null, opts?: UsePricesOptions) {
  const q = usePrices(mint ? [mint] : [], opts);
  const info: PriceInfo | undefined = mint ? q.data?.[mint] : undefined;
  return { ...q, price: info?.usdPrice, info };
}
