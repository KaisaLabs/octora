import { useEffect, useState, useMemo } from "react";

import { AppFooter } from "@/components/octora/AppFooter";
import { AppHeader } from "@/components/octora/AppHeader";
import { OctoraPlatform } from "@/components/octora/OctoraPlatform";
import type { Pool } from "@/components/octora/types";
import { footerLinks, portfolioActivity, portfolioSummary, portfolioPositions } from "@/data/octora";
import { listPools, mapPoolSummary } from "@/lib/api";

const AppPage = () => {
  const [rawPools, setRawPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listPools({ network: "mainnet", limit: 50 })
      .then((summaries) => {
        if (!cancelled) {
          setRawPools(summaries.map(mapPoolSummary));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load pools");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Memoize mapped pools to keep reference stable
  const pools = useMemo(() => rawPools, [rawPools]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50" aria-hidden="true">
        <div className="absolute inset-x-0 top-0 h-px bg-border" />
        <div className="absolute left-0 right-0 top-0 h-[520px] grid-fade" />
      </div>

      <AppHeader />

      <main>
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-muted-foreground">Loading pools...</p>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-red-500">{error}</p>
          </div>
        ) : (
          <OctoraPlatform
            pools={pools}
            positions={portfolioPositions}
            activity={portfolioActivity}
            summary={portfolioSummary}
          />
        )}
      </main>

      <AppFooter links={footerLinks} />
    </div>
  );
};

export default AppPage;
