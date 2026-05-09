import { useMemo } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { getPoolDetail, mapPoolSummary, NETWORK } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import type { DistributionShape } from "@/components/octora/types";
import { PoolDetailView } from "@/components/octora/lp/PoolDetailView";

interface NavState {
  presetShape?: DistributionShape;
}

export function PoolDetailPage() {
  const { address = "" } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const presetShape = (location.state as NavState | null)?.presetShape;

  const { data, isLoading, error } = useQuery({
    queryKey: ["pool", address],
    queryFn: () => getPoolDetail(address, NETWORK),
    enabled: !!address,
    staleTime: 30_000,
  });

  const pool = useMemo(() => (data ? mapPoolSummary(data) : null), [data]);

  const goBack = () => {
    if (location.key !== "default") navigate(-1);
    else navigate("/");
  };

  if (isLoading) {
    return <PoolDetailSkeleton />;
  }

  if (error || !pool) {
    return (
      <section className="panel-shell rounded-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Pool not found."}
        </p>
        <Link
          to="/"
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to pools
        </Link>
      </section>
    );
  }

  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <PoolDetailView pool={pool} presetShape={presetShape} onBack={goBack} />
    </section>
  );
}

function PoolDetailSkeleton() {
  return (
    <section className="panel-shell space-y-5 rounded-2xl p-4 sm:p-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="flex gap-2">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid grid-cols-3 gap-3 lg:w-[480px]">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-10 w-72 rounded-lg" />
      <Skeleton className="h-72 rounded-2xl" />
    </section>
  );
}
