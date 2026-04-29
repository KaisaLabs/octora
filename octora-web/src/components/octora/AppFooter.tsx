import { ShieldCheck } from "lucide-react";

interface AppFooterProps {
  links: string[];
}

export function AppFooter({ links }: AppFooterProps) {
  return (
    <footer className="border-t border-border/70 py-8 sm:py-10">
      <div className="container flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">Octora</p>
          </div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Privacy-preserving execution for LP traders on Meteora.
          </p>
        </div>
        <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground sm:gap-6">
          {links.map((link) => (
            <a key={link} href="#" className="transition-colors duration-200 hover:text-foreground">
              {link}
            </a>
          ))}
        </nav>
      </div>
      <div className="container mt-6 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        © {new Date().getFullYear()} Octora — Not affiliated with Meteora.
      </div>
    </footer>
  );
}
