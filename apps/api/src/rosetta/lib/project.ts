// Shared helpers used by more than one rosetta domain service.
// Extracted verbatim from RosettaService (runConcurrent, tryDiscoverProject).

import { discoverProject, getAccessToken } from "../google-api";
import type { RosettaContext } from "./context";

/** Run async tasks with limited concurrency. */
export async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Discover + persist an antigravity account's projectId via the cloud API (mutates acc in place). */
export async function tryDiscoverProject(ctx: RosettaContext, acc: any): Promise<void> {
  if (!acc.refreshToken) return;
  try {
    const token = await getAccessToken(Number(acc.id), acc.refreshToken, ctx.tokenCache, acc.proxyUrl);
    const result = await discoverProject(token, undefined, acc.proxyUrl);
    if (result?.projectId) {
      acc.projectId = result.projectId;
      acc.projectIdSource = "api";
      if (result.planType) acc.planType = result.planType;
      ctx.logger.log(`Discovered project for ${acc.email}: ${result.projectId}`);
    }
  } catch (err: any) {
    ctx.logger.warn(`Project discovery failed for ${acc.email}: ${err.message}`);
  }
}
