import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { PrismaService } from "../../prisma/prisma.service";
import { CustomerJwtPayload, resolveCustomerJwtSecret } from "./customer-token.service";

export interface CustomerUser {
  customerId: string;
  email: string;
  deviceId: string | undefined;
  jti: string;
}

@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(Strategy, "user-jwt") {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveCustomerJwtSecret()
    });
  }

  async validate(payload: CustomerJwtPayload): Promise<CustomerUser> {
    // Reject tokens missing or wrong typ claim — this prevents admin tokens
    // from being accepted by the customer strategy.
    if (payload.typ !== "user-session") {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Token type mismatch"
      });
    }

    // Runs on the lease hot path — select only what validation needs
    // (avoids dragging passwordHash & co. out of the DB on every request).
    const customer = await this.prisma.customer.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, status: true, tokenVersion: true }
    });

    if (!customer) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    if (customer.status !== "ACTIVE") {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Account is not active"
      });
    }

    if (payload.tv !== customer.tokenVersion) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Session has been revoked"
      });
    }

    return {
      customerId: customer.id,
      email: customer.email,
      deviceId: payload.deviceId,
      jti: payload.jti
    };
  }
}
