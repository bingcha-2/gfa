import type { FairShareTracker } from "./fair-share-tracker";

/**
 * Process-wide registry of the per-provider FairShareTracker instances.
 *
 * Each product pool (antigravity / codex / anthropic) constructs its own
 * FairShareTracker (live in-memory, DB-persisted via its own flush/load). The
 * trackers self-register here by provider id so layers that only have a DI
 * boundary to the heartbeat (app-auth) — not to the lease services — can read a
 * subscription's live fair-share ("我的份额") without reaching across modules.
 *
 * Single Nest process → one shared instance is enough; no persistence of its own
 * (the trackers already persist). Mirrors the SHARED_ACCESS_KEY_STORE pattern.
 */
export class FairShareRegistry {
  private readonly byProvider = new Map<string, FairShareTracker>();

  register(provider: string, tracker: FairShareTracker): void {
    if (!provider) return;
    this.byProvider.set(provider, tracker);
  }

  get(provider: string): FairShareTracker | undefined {
    return this.byProvider.get(provider);
  }
}

/** Shared singleton — trackers self-register on construction; readers import this. */
export const sharedFairShareRegistry = new FairShareRegistry();
