import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SolanaProvider } from "@/providers/SolanaProvider";
import { AppShell } from "@/components/octora/AppShell";
import { PoolsPage } from "@/pages/PoolsPage";
import { PortfolioPage } from "@/pages/PortfolioPage";
import { ActivityPage } from "@/pages/ActivityPage";
import NotFound from "./pages/NotFound.tsx";

// MixerTestPage transitively imports circomlibjs + the mixer crypto bundle
// (~3MB). Lazy-load so the rest of the app renders without paying for it.
const MixerTestPage = lazy(() =>
  import("./pages/MixerTestPage").then((m) => ({ default: m.MixerTestPage })),
);
import type { Pool } from "@/components/octora/types";
import { listPools, mapPoolSummary } from "@/lib/api";
import { portfolioActivity, portfolioPositions } from "@/data/octora";

const queryClient = new QueryClient();

function AppRoutes() {
  const [rawPools, setRawPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listPools({ network: "mainnet", pageSize: 50 })
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

  const pools = useMemo(() => rawPools, [rawPools]);

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<PoolsPage pools={pools} loading={loading} error={error} />} />
        <Route path="portfolio" element={<PortfolioPage positions={portfolioPositions} />} />
        <Route path="activity" element={<ActivityPage activity={portfolioActivity} />} />
      </Route>
      <Route
        path="mixer-test"
        element={
          <Suspense
            fallback={
              <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
                Loading mixer crypto…
              </div>
            }
          >
            <MixerTestPage />
          </Suspense>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <SolanaProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </TooltipProvider>
    </SolanaProvider>
  </QueryClientProvider>
);

export default App;
