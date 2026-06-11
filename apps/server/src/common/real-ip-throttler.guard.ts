import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Custom ThrottlerGuard that extracts the real client IP from proxy headers.
 *
 * Problem: All frontend requests go through the Next.js proxy at localhost,
 * so the default ThrottlerGuard sees every request as coming from 127.0.0.1.
 * This causes ALL users to share a single rate-limit bucket, meaning one user
 * clicking once can trigger "Too Many Requests" if other users recently hit
 * the same endpoint.
 *
 * Solution: Read X-Forwarded-For / X-Real-IP headers set by the proxy to
 * identify the real client, then rate-limit per actual user IP.
 */
@Injectable()
export class RealIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Prefer X-Forwarded-For (first entry), then X-Real-IP, then fallback to req.ip
    const forwarded = req.headers?.["x-forwarded-for"];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
      return first.trim();
    }

    const realIp = req.headers?.["x-real-ip"];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0].trim() : realIp.trim();
    }

    return req.ip ?? "unknown";
  }
}
