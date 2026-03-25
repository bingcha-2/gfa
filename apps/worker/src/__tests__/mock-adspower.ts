/**
 * Mock AdsPowerClient for integration tests.
 *
 * Replaces real AdsPower HTTP calls with configurable fake responses.
 * No browser is actually started.
 */

import type { OpenProfileResult } from "../adspower-client";

export class MockAdsPowerClient {
  public openCalls: string[] = [];
  public closeCalls: string[] = [];
  public checkCalls: string[] = [];

  /** If set, openProfile() will throw this error */
  public openError: Error | null = null;

  async openProfile(profileId: string): Promise<OpenProfileResult> {
    this.openCalls.push(profileId);

    if (this.openError) {
      throw this.openError;
    }

    return {
      debugUrl: `ws://127.0.0.1:0/devtools/browser/fake-${profileId}`,
      webdriver: "",
    };
  }

  async closeProfile(profileId: string): Promise<void> {
    this.closeCalls.push(profileId);
  }

  async checkProfile(
    profileId: string
  ): Promise<{ active: boolean; debugUrl?: string }> {
    this.checkCalls.push(profileId);
    return { active: false };
  }

  /** Reset all call records and error states */
  reset() {
    this.openCalls = [];
    this.closeCalls = [];
    this.checkCalls = [];
    this.openError = null;
  }
}
