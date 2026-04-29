import { randomUUID } from "node:crypto";

import type { ActivityRecord, ExecutionState, PositionAction } from "#domain";

import type { ActivityRepository, ActivityRow } from "./activity.repository";
import type { PositionRow } from "./position.repository";

export interface ActivityService {
  record(
    position: PositionRow,
    state: ExecutionState,
    headline: string,
    detail: string,
    safeNextStep: ActivityRecord["safeNextStep"],
  ): Promise<ActivityRow>;
  list(positionId: string): Promise<ActivityRow[]>;
}

export function createActivityService(repo: ActivityRepository): ActivityService {
  return {
    async record(position, state, headline, detail, safeNextStep) {
      return repo.createActivity({
        id: randomUUID(),
        positionId: position.id,
        action: position.action as PositionAction,
        state,
        headline,
        detail,
        safeNextStep,
      });
    },
    async list(positionId) {
      return repo.listActivities(positionId);
    },
  };
}
