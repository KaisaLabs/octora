import { PublicKey } from '@solana/web3.js'
import { loadConfig, type DlmmProgramConfig } from '#common/config'

export interface DlmmProgramConstants {
  programId: PublicKey
  eventAuthority: PublicKey
  presetParameter: PublicKey
  binStep: number
  baseFactor: number
}

let cached: DlmmProgramConstants | null = null

export function getDlmmProgram(): DlmmProgramConstants {
  if (cached) return cached
  cached = resolveDlmmProgram(loadConfig().dlmm)
  return cached
}

export function resolveDlmmProgram(cfg: DlmmProgramConfig): DlmmProgramConstants {
  return {
    programId: new PublicKey(cfg.programId),
    eventAuthority: new PublicKey(cfg.eventAuthority),
    presetParameter: new PublicKey(cfg.presetParameter),
    binStep: cfg.binStep,
    baseFactor: cfg.baseFactor,
  }
}
