import { Component, type ReactNode } from "react";
import { captureException } from "@/lib/observability";

/**
 * Page-level error boundary.
 *
 * Catches uncaught React errors anywhere below it in the tree, reports
 * them to Sentry (with full breadcrumb trail), and shows a recovery
 * affordance instead of a blank page. Mounted once around `<App />` —
 * an exception in any route or modal bubbles up here.
 *
 * Doesn't catch async errors thrown outside React's render path (e.g.
 * orchestrator promises) — those are caught at each call site and
 * surfaced via Sentry.captureException explicitly.
 */
interface State {
  error: Error | null;
}

interface Props {
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    captureException(error, { componentStack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 text-sm">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-rose-300">
              Something went wrong
            </p>
            <p className="mt-2 font-display text-xl font-semibold text-foreground">
              The page crashed.
            </p>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            The error has been reported. Refresh to keep going, or if it
            happens again, screenshot this and send it to the team:
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-card/60 px-3 py-2 text-[11px] leading-5 text-rose-200">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/15"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }
}
