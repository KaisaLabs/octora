// Minimal browser shim for Node's `events` module, pulled in transitively
// by readable-stream (a snarkjs/circomlibjs dependency). We only need the
// EventEmitter constructor surface — the readable-stream code path that
// uses events is rarely (if ever) exercised by snarkjs.fullProve in browser.

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, fn: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }
  off(event: string | symbol, fn: Listener): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    this.listeners.set(
      event,
      list.filter((f) => f !== fn),
    );
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const fn of list) fn(...args);
    return true;
  }
  once(event: string | symbol, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
  addListener(event: string | symbol, fn: Listener): this {
    return this.on(event, fn);
  }
  removeListener(event: string | symbol, fn: Listener): this {
    return this.off(event, fn);
  }
  setMaxListeners(_n: number): this {
    return this;
  }
  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export default EventEmitter;
