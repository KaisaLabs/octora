export interface TokenIcon {
  /** Mint address. */
  mint: string
  /** HTTPS URL to the token icon, or null when Jupiter has no logoURI on file. */
  icon: string | null
  /** Display symbol, useful when the upstream pool record doesn't carry one. */
  symbol: string | null
}

/** Map of mint -> TokenIcon. Mints Jupiter doesn't know are still present with
 *  `icon: null` so the client can cache "no icon" and stop re-asking. */
export type TokenIconMap = Record<string, TokenIcon>
