import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";

/**
 * WebJwtGuard — skeleton guard for the customer web portal surface.
 *
 * TODO(milestone 2): replace with the real Customer JWT strategy guard.
 * Until then every request is rejected so no customer endpoint can be
 * accidentally exposed.
 */
@Injectable()
export class WebJwtGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    throw new UnauthorizedException("customer session required");
  }
}
