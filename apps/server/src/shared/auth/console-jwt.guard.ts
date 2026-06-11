import { Injectable } from "@nestjs/common";

import { JwtAuthGuard } from "./jwt-auth.guard";

/**
 * ConsoleJwtGuard — explicit guard for console-surface controllers.
 *
 * Semantics are identical to the global admin JwtAuthGuard today (admin JWT,
 * honors @Public()). It exists so console controllers can opt into an explicit
 * surface guard as the route surfaces split apart in later milestones.
 *
 * Not yet applied anywhere — console routes are still covered by the global
 * JwtAuthGuard; new console-only controllers (Plan CRUD etc., milestone 4+)
 * will apply it explicitly.
 */
@Injectable()
export class ConsoleJwtGuard extends JwtAuthGuard {}
