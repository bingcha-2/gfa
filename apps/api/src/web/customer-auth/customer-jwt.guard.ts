import {
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * CustomerJwtGuard — explicit guard for customer-facing endpoints.
 *
 * Uses the "user-jwt" passport strategy, which is entirely independent from
 * the admin "jwt" strategy — different secret, different typ claim. An admin
 * token cannot pass this guard (type mismatch); a customer token cannot pass
 * the global JwtAuthGuard (it is marked @Public() on all customer controllers).
 *
 * Error contract:
 *   Missing / malformed Authorization header → 401 { error: "UNAUTHORIZED" }
 *   Valid JWT but session revoked / account disabled → 401 { error: "SESSION_INVALID" }
 */
@Injectable()
export class CustomerJwtGuard extends AuthGuard("user-jwt") {
  override handleRequest<T = any>(err: any, user: T, info: any): T {
    if (err) {
      // Strategy threw UnauthorizedException with a structured body — re-throw as-is
      throw err;
    }

    if (!user) {
      // No user means missing/invalid/expired token
      throw new UnauthorizedException({
        error: "UNAUTHORIZED",
        message: info?.message ?? "Missing or invalid authorization header"
      });
    }

    return user;
  }

  override canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}
