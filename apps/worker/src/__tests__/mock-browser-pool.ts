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

  async releaseAccount(_accountId: string, _workerId: string): Promise<void> {}

  async isLoginCoolingDown(_accountId: string): Promise<number> {
    return 0;
  }

  async isInviteCoolingDown(_accountId: string): Promise<number> {
    return 0;
  }

  startHeartbeat(_profileId: string, _accountId: string, _workerId: string): () => void {
    return () => {};
  }

  createForceCloseGuard(_workerId: string): (profileId: string) => Promise<boolean> {
    return async (_profileId: string) => true;
  }

  async acquireAndOpen(
    _workerId: string,
    _accountId: string,
    _adspower: any,
    _opts?: any
  ): Promise<{ profileId: string; debugUrl: string }> {
    if (this.exhausted) {
      throw new Error("[MockBrowserPool] No free profile available (simulated exhaustion)");
    }
    this.acquireCalls.push(this.profileId);
    return { profileId: this.profileId, debugUrl: "ws://mock-debug-url" };
  }

  async recordLoginFailure(_accountId: string, _ttlMs: number): Promise<void> {}

  async setLastAccount(_profileId: string, _accountId: string): Promise<void> {}

  async acquireForAccount(
    _workerId: string,
    _accountId: string,
    _timeoutMs?: number,
    _excludeProfiles?: Set<string>
  ): Promise<{ profileId: string }> {
    if (this.exhausted) {
      throw new Error("[MockBrowserPool] No free profile available (simulated exhaustion)");
    }
    this.acquireCalls.push(this.profileId);
    return { profileId: this.profileId };
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
