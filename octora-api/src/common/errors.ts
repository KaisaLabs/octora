export class PositionNotFoundError extends Error {
  constructor(positionId: string) {
    super(`Position ${positionId} not found`);
    this.name = "PositionNotFoundError";
  }
}

export class UnsupportedPositionActionError extends Error {
  constructor(action: string) {
    super(`Task 7 only implements add-liquidity execution, not ${action}`);
    this.name = "UnsupportedPositionActionError";
  }
}
