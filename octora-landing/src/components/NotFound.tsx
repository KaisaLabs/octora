import { Construction, ArrowLeft } from "lucide-react";

export function NotFound() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-base px-6 text-white">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-amber-500/20 bg-amber-500/10">
          <Construction className="h-8 w-8 text-amber-400" />
        </div>
        <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
          Under Construction
        </h1>
        <p className="mt-4 text-sm leading-7 text-emerald-100/50">
          This page isn't ready yet. We're still building it out.
        </p>
        <a
          href="/"
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-emerald-500 px-6 py-3 text-sm font-semibold text-[#010504] transition-all hover:bg-emerald-400 hover:shadow-[0_0_24px_rgba(16,185,129,0.4)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Home
        </a>
      </div>
    </div>
  );
}
