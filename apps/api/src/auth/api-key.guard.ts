import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * API Key guard for automation endpoints.
 *
 * Checks for `X-Api-Key` header matching the AUTOMATION_API_KEY env variable.
 * If AUTOMATION_API_KEY is not configured, all requests are BLOCKED
 * (fail-closed for safety).
 *
 * Usage: Apply @UseGuards(ApiKeyGuard) on controllers/methods.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("AUTOMATION_API_KEY");

    if (!this.apiKey) {
      console.warn(
        "[SECURITY] AUTOMATION_API_KEY is not set. " +
        "All automation endpoints will be BLOCKED until configured."
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // Fail-closed: if no API key is configured, block everything
    if (!this.apiKey) {
      throw new ForbiddenException("Automation API key is not configured on server");
    }

    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers["x-api-key"];

    if (!providedKey || providedKey !== this.apiKey) {
      throw new ForbiddenException("Invalid or missing API key");
    }

    return true;
  }
}
