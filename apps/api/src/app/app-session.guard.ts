import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

/**
 * AppSessionGuard — skeleton guard for the desktop client surface.
 *
 * TODO(milestone 2): replace with the real Customer session JWT strategy
 * guard. Until then every request is rejected so no client endpoint can be
 * accidentally exposed.
 */
@Injectable()
export class AppSessionGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    throw new UnauthorizedException("customer session required");
  }
}
