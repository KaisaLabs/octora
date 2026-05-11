import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getTokenIcons, type TokenIconMap } from "@/lib/api";

// Icons rarely change; the backend caches for 1h. A long client staleTime
// keeps the same icon set across navigations without hammering the API.
const STALE_MS = 60 * 60 * 1_000;

/**
 * Resolve Jupiter-hosted token icon URLs for a set of mints. The query is
 * keyed by the sorted+deduped mint list so the same visible set never refires
 * a fetch. Mints Jupiter has no record of come back with `icon: null` and are
 * still cached so the UI can settle on the initials fallback without retrying.
 */
export function useTokenIcons(mints: Array<string | undefined | null>) {
  const ids = useMemo(() => {
    const set = new Set<string>();
    for (const m of mints) {
      if (typeof m === "string" && m.length >= 32) set.add(m);
    }
    return [...set].sort();
  }, [mints]);

  return useQuery<TokenIconMap>({
    queryKey: ["tokenIcons", ids],
    queryFn: () => getTokenIcons(ids),
    enabled: ids.length > 0,
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    placeholderData: (prev) => prev,
  });
}
