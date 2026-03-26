/**
 * Mock BrowserPool for integration tests.
 *
 * Always returns "mock-pool-profile" by default.
 * Can be configured to simulate pool exhaustion (timeout).
 */

export class MockBrowserPool {
  public acquireCalls: string[] = [];
  public releaseCalls: string[] = [];

  /** If true, acquire() will throw (simulate pool exhaustion timeout) */
  public exhausted = false;

  /** The profile ID returned by acquire() */
  public profileId = "mock-pool-profile";

  async acquire(_workerId: string, _timeoutMs?: number): Promise<string> {
    if (this.exhausted) {
      throw new Error("[MockBrowserPool] No free profile available (simulated exhaustion)");
    }
    this.acquireCalls.push(this.profileId);
    return this.profileId;
  }

  async release(profileId: string, _workerId: string): Promise<void> {
    this.releaseCalls.push(profileId);
  }

  async freeCount(): Promise<number> {
    return this.exhausted ? 0 : 1;
  }

  get poolSize(): number { return 1; }

  reset() {
    this.acquireCalls = [];
    this.releaseCalls = [];
    this.exhausted = false;
  }
}
