import { useState, type FormEvent } from "react";
import { Check, ArrowRight, Loader2 } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setState("error");
      setErrorMsg("Please enter a valid email.");
      return;
    }

    setState("loading");

    // Simulate API call — replace with actual endpoint
    setTimeout(() => {
      setState("success");
    }, 1200);
  };

  return (
    <section id="waitlist" className="px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-2xl">
        <ScrollReveal className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-emerald-100/50">
            Early Access
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Get on the waitlist.
          </h2>
          <p className="mt-3 text-sm leading-7 text-emerald-100/50">
            Be the first to LP privately on Meteora. No spam, just launch updates.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={0.15} className="mt-10">
          {state === "success" ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 py-10">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20">
                <Check className="h-6 w-6 text-emerald-400" />
              </div>
              <p className="text-lg font-semibold text-white">You're on the list!</p>
              <p className="text-sm text-emerald-100/50">
                We'll reach out when it's your turn.
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col gap-3 sm:flex-row"
            >
              <div className="relative flex-1">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (state === "error") setState("idle");
                  }}
                  placeholder="you@example.com"
                  className="h-12 w-full rounded-full border border-emerald-500/15 bg-emerald-950/30 px-5 text-sm text-white placeholder-emerald-100/30 outline-none transition-colors focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20"
                />
                {state === "error" && (
                  <p className="absolute -bottom-6 left-5 text-xs text-red-400">
                    {errorMsg}
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={state === "loading"}
                className="flex h-12 items-center justify-center gap-2 rounded-full bg-emerald-500 px-8 text-sm font-semibold text-[#010504] transition-all hover:bg-emerald-400 hover:shadow-[0_0_24px_rgba(16,185,129,0.4)] disabled:opacity-60"
              >
                {state === "loading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Join Waitlist
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </ScrollReveal>
      </div>
    </section>
  );
}
