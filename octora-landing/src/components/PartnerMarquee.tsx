const PROTOCOLS = [
  { name: "Solana", logo: "/logo/solana.png" },
  { name: "Meteora", logo: "/logo/meteora.png" },
];

// @ts-ignore: commented out pending community approval
const SUPPORTERS = [
  { name: "Superteam", logo: "/logo/superteam.jpg" },
];

export function PartnerMarquee() {
  return (
    <section className="relative py-20">
      {/* Protocols */}
      <div className="mx-auto max-w-2xl px-6 text-center">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-400/50">
          Ecosystem
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Built on the protocols you trust.
        </h2>
        <p className="mt-3 text-sm leading-7 text-emerald-100/50">
          Octora integrates with Solana's best protocols to keep your liquidity
          private at every layer.
        </p>
      </div>

      <div className="mt-10 flex items-center justify-center gap-10">
        {PROTOCOLS.map((p) => (
          <img
            key={p.name}
            src={p.logo}
            alt={p.name}
            className="h-32 w-auto object-contain opacity-50 transition-opacity hover:opacity-80"
          />
        ))}
      </div>

      {/*Supporters — uncomment when community confirms*/}
      <div className="mx-auto mt-20 max-w-2xl px-6 text-center">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-400/50">
          Backed By
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Supported by the community.
        </h2>
        <p className="mt-3 text-sm leading-7 text-emerald-100/50">
          Backed by the communities that champion builders in the Solana
          ecosystem.
        </p>
      </div>

      <div className="mt-10 flex items-center justify-center gap-10">
        {SUPPORTERS.map((p) => (
          <img
            key={p.name}
            src={p.logo}
            alt={p.name}
            className="h-32 w-auto rounded-full object-contain opacity-50 transition-opacity hover:opacity-80"
          />
        ))}
      </div>
    </section>
  );
}
