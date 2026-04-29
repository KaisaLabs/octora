import { Radar, Sparkles } from "lucide-react";

interface TimelineItem {
  title: string;
  detail: string;
  state: string;
}

interface ExecutionTimelineProps {
  items: TimelineItem[];
}

export function ExecutionTimeline({ items }: ExecutionTimelineProps) {
  return (
    <section className="panel-shell rounded-xl p-6 animate-fade-in [animation-delay:360ms]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">Execution flow</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Private route lifecycle</h2>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-secondary/55">
          <Radar className="text-primary" />
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {items.map((item, index) => (
          <div key={item.title} className="flex gap-4 rounded-xl border border-border/70 bg-secondary/40 p-4 motion-safe-lift">
            <div className="flex flex-col items-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-sm font-semibold text-primary">
                {index + 1}
              </span>
              {index < items.length - 1 ? <span className="mt-2 h-full w-px bg-border/70" /> : null}
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium text-foreground">{item.title}</h3>
                <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  {item.state}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
