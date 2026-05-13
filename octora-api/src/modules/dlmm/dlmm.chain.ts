import { Connection, PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'
import { BN } from '@coral-xyz/anchor'
import { loadConfig } from '#common/config'
import { MeteoraApiError } from './dlmm.api.shared.js'
import type {
  Network,
  PoolDetail,
  PoolBins,
  LiquidityBin,
} from './dlmm.types.js'

const RPC_URL: Record<Network, string> = loadConfig().dlmmRpcUrls

const connections: Partial<Record<Network, Connection>> = {}
function getConnection(network: Network): Connection {
  let conn = connections[network]
  if (!conn) {
    conn = new Connection(RPC_URL[network], 'confirmed')
    connections[network] = conn
  }
  return conn
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
  const conn = getConnection(network)
  const instance = await (DLMM as any).create(conn, new PublicKey(address))
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

  const { activeBin, bins } = (await dlmm.getBinsAroundActiveBin(half, half)) as {
    activeBin: number
    bins: Array<{ binId: number; price: string; xAmount: any; yAmount: any }>
  }

  const tokenXDecimals: number = dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals ?? 0
  const tokenYDecimals: number = dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals ?? 0
  const binStep: number = dlmm.lbPair?.binStep ?? 0

  const out: LiquidityBin[] = bins.map((b) => {
    const price = Number(b.price)
    const x = decimalize(b.xAmount, tokenXDecimals)
    const y = decimalize(b.yAmount, tokenYDecimals)
    const liquidity = y + (Number.isFinite(price) ? x * price : 0)
    return {
      binId: b.binId,
      price,
      liquidity,
      xAmount: bnToString(b.xAmount),
      yAmount: bnToString(b.yAmount),
    }
  })

  return {
    address,
    network,
    activeBinId: activeBin,
    binStep,
    bins: out,
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
  const conn = getConnection(network)
  const lbPair: any = dlmm.lbPair
  const tokenXMint: PublicKey = dlmm.tokenX?.publicKey ?? new PublicKey(lbPair.tokenXMint)
  const tokenYMint: PublicKey = dlmm.tokenY?.publicKey ?? new PublicKey(lbPair.tokenYMint)

  const [xDecimals, yDecimals] = await Promise.all([
    fetchMintDecimals(conn, tokenXMint, dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals),
    fetchMintDecimals(conn, tokenYMint, dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals),
  ])

  const xSymbol = labelForMint(tokenXMint)
  const ySymbol = labelForMint(tokenYMint)
  const binStep = Number(lbPair.binStep ?? 0)
  const baseFactor = Number(lbPair.parameters?.baseFactor ?? 0)
  const baseFeeBps = Math.round((baseFactor * binStep) / 100)
  const activeBinId = Number(lbPair.activeId ?? 0)

  // Active bin price in tokenY-per-tokenX, scaled per the binStep formula:
  //   price = (1 + binStep/10_000) ** activeId
  const price = Math.pow(1 + binStep / 10_000, activeBinId)

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
  conn: Connection,
  mint: PublicKey,
  fallback: number | undefined,
): Promise<number> {
  if (typeof fallback === 'number') return fallback
  const acct = await conn.getAccountInfo(mint, 'confirmed')
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
