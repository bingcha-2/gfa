/**
 * Mock ProfileLock for integration tests.
 *
 * Always succeeds by default. Can be configured to simulate lock contention.
 */

export class MockProfileLock {
  public acquireCalls: string[] = [];
  public releaseCalls: string[] = [];

  /** If true, acquire() will fail (simulate contention) */
  public locked = false;

  async acquire(profileId: string, _workerId: string): Promise<boolean> {
    this.acquireCalls.push(profileId);
    return !this.locked;
  }

  async release(profileId: string, _workerId: string): Promise<boolean> {
    this.releaseCalls.push(profileId);
    return true;
  }

  async extend(
    _profileId: string,
    _workerId: string,
    _ttlMs?: number
  ): Promise<boolean> {
    return true;
  }

  reset() {
    this.acquireCalls = [];
    this.releaseCalls = [];
    this.locked = false;
  }
}
