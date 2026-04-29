interface OctoraFooterProps {
  links: string[];
}

export function OctoraFooter({ links }: OctoraFooterProps) {
  return (
    <footer className="border-t border-border/60 py-8">
      <div className="container flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Octora</p>
          <p className="mt-1 text-sm text-muted-foreground">Private liquidity operations for serious Solana LPs.</p>
        </div>
        <nav className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {links.map((link) => (
            <a key={link} href="#" className="transition-colors duration-300 hover:text-foreground">
              {link}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
