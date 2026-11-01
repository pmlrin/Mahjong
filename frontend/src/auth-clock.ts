// Anchor deadlines to the server response and advance them using elapsed time.
// Browser wall-clock corrections must not extend a code or prematurely hide it.
export class AuthClock {
  private serverTime: number;
  private receivedAt: number;
  constructor(
    private readonly monotonic: () => number = () => performance.now(),
    initialTime = Date.now(),
  ) {
    this.serverTime = initialTime;
    this.receivedAt = monotonic();
  }
  sync(serverTime: unknown) {
    if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) return;
    this.serverTime = serverTime;
    this.receivedAt = this.monotonic();
  }
  now() {
    return this.serverTime + Math.max(0, this.monotonic() - this.receivedAt);
  }
}
