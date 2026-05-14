import { PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'
import { BN } from '@coral-xyz/anchor'
import type { SolanaChain } from '#common/solana/chain'
import { MeteoraApiError } from './dlmm.api.shared.js'
import type {
  Network,
  PoolDetail,
  PoolBins,
  LiquidityBin,
} from './dlmm.types.js'

/**
 * Per-network DLMM chain bag. Wired once at boot via
 * `configureDlmmChain` so the chain-direct reads (`getPoolBins`,
 * `getPoolFromChain`, `getSwapQuote`) don't have to take a chain
 * argument on every call — that would force the controller into a
 * factory rewrite that this step is trying to keep out of scope.
 *
 * The previous version of this file read `loadConfig().dlmmRpcUrls`
 * directly and built `new Connection(...)` per network; the per-network
 * split is load-bearing (see the footgun comment in
 * src/common/config/index.ts about cross-cluster RPC leakage).
 */
let chainByNetwork: Partial<Record<Network, SolanaChain>> = {}

export function configureDlmmChain(opts: {
  chains: Record<Network, SolanaChain>
}): void {
  chainByNetwork = { ...opts.chains }
  // Drop any cached DLMM instances so they don't keep pointing at the
  // previous Connection underneath the chain — matters for tests that
  // reconfigure between cases.
  dlmmCache.clear()
}

function getChain(network: Network): SolanaChain {
  const chain = chainByNetwork[network]
  if (!chain) {
    throw new Error(
      `dlmm.chain: no SolanaChain configured for network "${network}". ` +
        'Call configureDlmmChain({ chains }) at boot (app.ts wires this).',
    )
  }
  return chain
}

interface CachedDlmm {
  instance: any
  createdAt: number
}

const DLMM_CACHE_TTL_MS = 30_000
const dlmmCache = new Map<string, CachedDlmm>()

async function getDlmmInstance(address: string, network: Network) {
  const key = `${network}:${address}`
  const cached = dlmmCache.get(key)
  if (cached && Date.now() - cached.createdAt < DLMM_CACHE_TTL_MS) {
    return cached.instance
  }
  const chain = getChain(network)
  const instance = await (DLMM as any).create(chain.rawConnection(), new PublicKey(address))
  dlmmCache.set(key, { instance, createdAt: Date.now() })
  return instance
}

export async function getPoolBins(
  address: string,
  network: Network,
  opts: { count?: number } = {},
): Promise<PoolBins> {
  const count = Math.max(7, Math.min(opts.count ?? 61, 201))
  const half = Math.floor(count / 2)

  let dlmm: any
  try {
    dlmm = await getDlmmInstance(address, network)
  } catch (err: any) {
    throw new MeteoraApiError(404, `DLMM pool not found: ${err?.message ?? String(err)}`)
  }

  const tokenXDecimals: number = dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals ?? 0
  const tokenYDecimals: number = dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals ?? 0
  const binStep: number = dlmm.lbPair?.binStep ?? 0

  // Try the SDK's full bin-window read first. For fresh pools with only one
  // bin array initialised, the SDK's outward walk can throw when it hits an
  // un-allocated neighbour. Fall back to synthesising bins around the real
  // on-chain `lbPair.activeId` so the UI still gets the correct active bin
  // and a usable price axis — single-sided SOL deposits don't require any
  // existing bin liquidity, only a correct active id.
  try {
    const { activeBin, bins } = (await dlmm.getBinsAroundActiveBin(half, half)) as {
      activeBin: number
      bins: Array<{
        binId: number
        /** Raw price-per-lamport `(1+bs/10000)^binId`. NOT decimal-adjusted. */
        price: string
        /** `price * 10^(decX-decY)` — human-readable tokenY-per-tokenX. */
        pricePerToken: string
        xAmount: any
        yAmount: any
      }>
    }

    const out: LiquidityBin[] = bins.map((b) => {
      // Use `pricePerToken` so the price axis is in tokenY-per-tokenX (the
      // unit users expect — same one discovery shows after converting via
      // an oracle). Falls back to recomputing from `price` if the SDK ever
      // changes its bin shape.
      const ppt = b.pricePerToken ? Number(b.pricePerToken) : Number(b.price) * Math.pow(10, tokenXDecimals - tokenYDecimals)
      const x = decimalize(b.xAmount, tokenXDecimals)
      const y = decimalize(b.yAmount, tokenYDecimals)
      const liquidity = y + (Number.isFinite(ppt) ? x * ppt : 0)
      return {
        binId: b.binId,
        price: ppt,
        liquidity,
        xAmount: bnToString(b.xAmount),
        yAmount: bnToString(b.yAmount),
      }
    })

    return { address, network, activeBinId: activeBin, binStep, bins: out }
  } catch (err: any) {
    const activeBin = Number(dlmm.lbPair?.activeId ?? 0)
    if (!Number.isFinite(activeBin)) {
      throw new MeteoraApiError(
        502,
        `Failed to read bins for ${address}: ${err?.message ?? String(err)}`,
      )
    }
    const decimalAdj = Math.pow(10, tokenXDecimals - tokenYDecimals)
    const ratio = 1 + binStep / 10_000
    const out: LiquidityBin[] = []
    for (let i = -half; i <= half; i++) {
      const binId = activeBin + i
      const price = Math.pow(ratio, binId) * decimalAdj
      out.push({
        binId,
        price,
        liquidity: 0,
        xAmount: '0',
        yAmount: '0',
      })
    }
    return { address, network, activeBinId: activeBin, binStep, bins: out }
  }
}

function decimalize(raw: any, decimals: number): number {
  if (raw == null) return 0
  const s = typeof raw === 'string' ? raw : raw.toString?.() ?? String(raw)
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return n / Math.pow(10, decimals || 0)
}

function bnToString(raw: any): string {
  if (raw == null) return '0'
  return typeof raw === 'string' ? raw : raw.toString?.() ?? String(raw)
}

export async function getPoolFromChain(address: string, network: Network): Promise<PoolDetail | null> {
  let dlmm: any
  try {
    dlmm = await getDlmmInstance(address, network)
  } catch {
    return null
  }
  const chain = getChain(network)
  const lbPair: any = dlmm.lbPair
  const tokenXMint: PublicKey = dlmm.tokenX?.publicKey ?? new PublicKey(lbPair.tokenXMint)
  const tokenYMint: PublicKey = dlmm.tokenY?.publicKey ?? new PublicKey(lbPair.tokenYMint)

  const [xDecimals, yDecimals] = await Promise.all([
    fetchMintDecimals(chain, tokenXMint, dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals),
    fetchMintDecimals(chain, tokenYMint, dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals),
  ])

  const xSymbol = labelForMint(tokenXMint)
  const ySymbol = labelForMint(tokenYMint)
  const binStep = Number(lbPair.binStep ?? 0)
  const baseFactor = Number(lbPair.parameters?.baseFactor ?? 0)
  const baseFeeBps = Math.round((baseFactor * binStep) / 100)
  const activeBinId = Number(lbPair.activeId ?? 0)

  // Active bin price in tokenY-per-tokenX, scaled per the binStep formula
  // AND adjusted for the per-token decimal difference. Without the decimal
  // adjustment this returns the per-lamport price, which doesn't match
  // the USD-per-token figures shown in discovery (and is unitless to a
  // user who hasn't dug into how DLMM stores prices).
  //   pricePerLamport = (1 + binStep/10_000) ** activeId
  //   pricePerToken   = pricePerLamport * 10^(decX - decY)
  const price =
    Math.pow(1 + binStep / 10_000, activeBinId) *
    Math.pow(10, xDecimals - yDecimals)

  return {
    address,
    name: `${xSymbol}-${ySymbol}`,
    pair: `${xSymbol}/${ySymbol}`,
    tokenX: { symbol: xSymbol, mint: tokenXMint.toBase58(), decimals: xDecimals },
    tokenY: { symbol: ySymbol, mint: tokenYMint.toBase58(), decimals: yDecimals },
    tvl: 0,
    volume24h: 0,
    fees24h: 0,
    volumeByTf: {},
    feesByTf: {},
    apr: 0,
    feeBps: baseFeeBps,
    binStep,
    baseFee: baseFeeBps,
    createdAt: 0,
    network,
    currentPrice: price,
    priceChange24h: 0,
    activeBinId,
    price,
    priceRange: { min: 0, max: 0 },
    liquidityShape: 'unknown',
    totalLiquidity: 0,
    feeInfo: {
      baseFeeBps,
      maxFeeBps: baseFeeBps,
      protocolFeeBps: Number(lbPair.parameters?.protocolShare ?? 0),
    },
  }
}

async function fetchMintDecimals(
  chain: SolanaChain,
  mint: PublicKey,
  fallback: number | undefined,
): Promise<number> {
  if (typeof fallback === 'number') return fallback
  const acct = await chain.getAccountInfo(mint, 'confirmed')
  if (!acct || acct.data.length < 45) return 0
  // SPL mint layout: decimals at byte 44 (after mintAuthority option + supply).
  return acct.data[44]
}

function labelForMint(mint: PublicKey): string {
  const NATIVE_MINT_BS58 = 'So11111111111111111111111111111111111111112'
  if (mint.toBase58() === NATIVE_MINT_BS58) return 'SOL'
  return mint.toBase58().slice(0, 4)
}

export interface SwapQuoteResult {
  /** Lamports the user is paying in. Echoed back for caller sanity-check. */
  amountIn: string
  /** Lamports the user receives after fees and slippage (pre-slippage estimate). */
  expectedOut: string
  /** Lamports the user is guaranteed to receive (after `allowedSlippageBps`). */
  minOut: string
  /** Slippage tolerance the quote was computed with, in BPS. */
  allowedSlippageBps: number
  /** Lamports of the input the swap actually consumed (partial fills possible). */
  consumedIn: string
  /** Total fee paid in output-token lamports. */
  feeLamports: string
  /** Decimal price impact, e.g. "0.0124" for 1.24 %. */
  priceImpact: string
  /** End price after the swap (output-token-per-input-token). */
  endPrice: string
  /** Direction echoed back: tokenX → tokenY when true. */
  swapForY: boolean
}

/**
 * Compute an unsigned swap quote against a DLMM pool.
 *
 * The browser orchestrators (privateExit, privateClaim) call this to learn
 * how much SOL their stealth-held non-SOL balance will yield before they
 * build the on-chain `dlmm_swap` tx — without an accurate quote the
 * `min_amount_out` arg has to be set to 1 (no protection) or a placeholder
 * that misreads tokens with non-unit per-lamport value, causing every swap
 * for real meme tokens to revert.
 *
 * Wraps Meteora SDK's `swapQuote`. Returns lamports as decimal strings so
 * the browser doesn't have to handle BNs.
 */
export async function getSwapQuote(
  poolAddress: string,
  network: Network,
  opts: {
    amountIn: bigint
    swapForY: boolean
    allowedSlippageBps?: number
  },
): Promise<SwapQuoteResult> {
  const allowedSlippageBps = Math.max(0, Math.min(opts.allowedSlippageBps ?? 500, 2000))
  let dlmm: any
  try {
    dlmm = await getDlmmInstance(poolAddress, network)
  } catch (err: any) {
    throw new MeteoraApiError(404, `DLMM pool not found: ${err?.message ?? String(err)}`)
  }

  // Pull a window of bin arrays around the active bin. `getBinArrayForSwap`
  // walks outward from the active bin in the direction the swap will move
  // the price, so the SDK's quote routine sees enough liquidity to reach
  // the requested input size without an out-of-bins error on big swaps.
  const binArrays = await dlmm.getBinArrayForSwap(opts.swapForY, 4)

  const inAmountBn = new BN(opts.amountIn.toString())
  const allowedSlippageBn = new BN(allowedSlippageBps)

  let quote: any
  try {
    quote = dlmm.swapQuote(inAmountBn, opts.swapForY, allowedSlippageBn, binArrays, false)
  } catch (err: any) {
    throw new MeteoraApiError(
      422,
      `Swap quote failed: ${err?.message ?? String(err)}. ` +
        'Pool may have insufficient liquidity in the requested direction.',
    )
  }

  return {
    amountIn: opts.amountIn.toString(),
    expectedOut: quote.outAmount.toString(),
    minOut: quote.minOutAmount.toString(),
    allowedSlippageBps,
    consumedIn: quote.consumedInAmount.toString(),
    feeLamports: quote.fee.toString(),
    priceImpact: quote.priceImpact.toString(),
    endPrice: quote.endPrice.toString(),
    swapForY: opts.swapForY,
  }
}
