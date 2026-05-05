import type { ComponentType, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "../../lib/cn";

export function BentoGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid w-full auto-rows-[12rem] grid-cols-3 gap-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BentoCard({
  name,
  className,
  background,
  Icon,
  description,
  href,
  cta,
  children,
}: {
  name: string;
  className?: string;
  background?: ReactNode;
  Icon?: ComponentType<{ className?: string }>;
  description?: string;
  href?: string;
  cta?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative col-span-3 flex flex-col justify-between overflow-hidden rounded-2xl",
        "border border-emerald-500/15 bg-emerald-950/20",
        "shadow-[0_1px_0_0_rgba(16,185,129,0.05)_inset]",
        "transition-all duration-300 hover:border-emerald-500/30",
        className,
      )}
    >
      {background ? (
        <div className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_top,transparent_10%,#000_60%)]">
          {background}
        </div>
      ) : null}

      <div className="pointer-events-none relative z-10 flex transform-gpu flex-col gap-1 px-5 pt-5">
        {Icon ? (
          <Icon className="h-6 w-6 text-emerald-400" />
        ) : null}
        <h3 className="mt-1 text-sm font-semibold text-white">{name}</h3>
        {description ? (
          <p className="text-xs text-emerald-100/50">{description}</p>
        ) : null}
      </div>

      {children ? (
        <div className="pointer-events-auto relative z-10 flex-1 px-5 pt-3 pb-5">
          {children}
        </div>
      ) : null}

      {href && cta ? (
        <div
          className={cn(
            "pointer-events-none absolute bottom-0 flex w-full translate-y-10 transform-gpu flex-row items-center p-4 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100",
          )}
        >
          <a
            href={href}
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-4 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20"
          >
            {cta}
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-0 transform-gpu transition-all duration-300 group-hover:bg-emerald-500/[0.03]" />
    </div>
  );
}
