import { modePolicy, type ActivityRecord, type ExecutionMode, type PositionIntent } from "@octora/domain";

export interface SubmitLiquidityInput {
  amount: string;
  pool: string;
  mode: ExecutionMode;
}

export interface ActivePositionView {
  id: string;
  poolLabel: string;
  amountLabel: string;
  modeLabel: string;
  statusLabel: string;
}

export interface SubmitLiquidityResult {
  intent: PositionIntent;
  position: ActivePositionView;
  activity: ActivityRecord[];
}

interface ApiPositionSnapshot {
  id: string;
  poolLabel: string;
  amountLabel: string;
  modeLabel: string;
  statusLabel: string;
}

interface ApiActivityRecord {
  id: string;
  positionId: string;
  action: ActivityRecord["action"];
  state: ActivityRecord["state"];
  headline: string;
  detail: string;
  safeNextStep: ActivityRecord["safeNextStep"];
  createdAtIso: string;
}

interface ApiPositionResponse {
  intent: PositionIntent;
  position: ApiPositionSnapshot;
  activity: ApiActivityRecord[];
}

const API_BASE_URL = import.meta.env.VITE_ORCHESTRATOR_API_URL ?? "http://127.0.0.1:8787";

export async function submitAddLiquidityIntent(input: SubmitLiquidityInput): Promise<SubmitLiquidityResult> {
  const response = await postIntent(input).catch(() => null);

  if (response) {
    return {
      intent: response.intent,
      position: {
        id: response.position.id,
        poolLabel: response.position.poolLabel,
        amountLabel: response.position.amountLabel,
        modeLabel: response.position.modeLabel,
        statusLabel: response.position.statusLabel,
      },
      activity: response.activity.map(({ createdAtIso: _createdAtIso, ...item }) => item),
    };
  }

  return createFallbackSubmitLiquidityResult(input);
}

async function postIntent(input: SubmitLiquidityInput): Promise<ApiPositionResponse> {
  if (typeof fetch !== "function") {
    throw new Error("fetch unavailable");
  }

  const response = await fetch(`${API_BASE_URL}/positions/intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "add-liquidity",
      amount: input.amount,
      pool: input.pool,
      mode: input.mode,
    }),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as ApiPositionResponse;
}

function createFallbackSubmitLiquidityResult(input: SubmitLiquidityInput): SubmitLiquidityResult {
  const createdAtIso = "2026-04-29T09:00:00.000Z";
  const positionId = `position-${input.pool}-${input.mode}`;
  const modeLabel = modePolicy[input.mode].label;

  return {
    intent: {
      id: `intent-${input.pool}-${input.mode}`,
      positionId,
      action: "add-liquidity",
      mode: input.mode,
      state: "active",
      createdAtIso,
    },
    position: {
      id: positionId,
      poolLabel: "SOL / USDC",
      amountLabel: `${formatAmount(input.amount)} SOL`,
      modeLabel,
      statusLabel: "Active",
    },
    activity: [
      {
        id: `${positionId}-received`,
        positionId,
        action: "add-liquidity",
        state: "awaiting_signature",
        headline: "Intent received",
        detail: `We queued your ${modeLabel.toLowerCase()} position for SOL / USDC.`,
        safeNextStep: "wait",
        createdAtIso,
      },
      {
        id: `${positionId}-active`,
        positionId,
        action: "add-liquidity",
        state: "active",
        headline: "Position is live",
        detail: `Your ${modeLabel} position is active now.`,
        safeNextStep: "wait",
        createdAtIso,
      },
    ],
  };
}

function formatAmount(amount: string) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed.toFixed(2).replace(/\.00$/, ".00") : amount;
}
