import { Injectable } from "@nestjs/common";

import { JwtAuthGuard } from "../auth/jwt-auth.guard";

/**
 * ConsoleJwtGuard — explicit guard for console-surface controllers.
 *
 * Semantics are identical to the global admin JwtAuthGuard today (admin JWT,
 * honors @Public()). It exists so console controllers can opt into an explicit
 * surface guard as the route surfaces split apart in later milestones.
 */
@Injectable()
export class ConsoleJwtGuard extends JwtAuthGuard {}
