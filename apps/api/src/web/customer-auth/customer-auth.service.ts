import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as bcrypt from "bcrypt";

import { PrismaService } from "../../prisma/prisma.service";
import { CustomerTokenService } from "./customer-token.service";

// bcrypt cost factor — 10 as spec'd
const BCRYPT_ROUNDS = 10;

// Referral code alphabet: A-Z plus 2-9 (excludes 0/O and 1/I for legibility)
const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LENGTH = 8;

export interface CustomerSanitized {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  referralCode: string;
  creditCents: number;
  status: string;
  createdAt: Date;
}

function sanitizeCustomer(customer: {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  referralCode: string;
  creditCents: number;
  status: string;
  createdAt: Date;
}): CustomerSanitized {
  return {
    id: customer.id,
    email: customer.email,
    displayName: customer.displayName,
    emailVerified: customer.emailVerified,
    referralCode: customer.referralCode,
    creditCents: customer.creditCents,
    status: customer.status,
    createdAt: customer.createdAt
  };
}

function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  }
  return code;
}

@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: CustomerTokenService
  ) {}

  async register(dto: {
    email: string;
    password: string;
    displayName?: string;
    referralCode?: string;
  }) {
    const email = dto.email.toLowerCase().trim();

    // Resolve inviter from referral code; unknown code is silently ignored
    let invitedById: string | undefined;
    if (dto.referralCode) {
      const inviter = await this.prisma.customer.findUnique({
        where: { referralCode: dto.referralCode },
        select: { id: true }
      });
      if (inviter) {
        invitedById = inviter.id;
      }
    }

    // Unique referral code with retry on collision
    let myReferralCode: string;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateReferralCode();
      const existing = await this.prisma.customer.findUnique({
        where: { referralCode: candidate },
        select: { id: true }
      });
      if (!existing) {
        myReferralCode = candidate;
        break;
      }
    }
    if (!myReferralCode!) {
      // Extremely unlikely; 8-char CROCKFORD32 = 32^8 ≈ 1 trillion combos
      throw new Error("Failed to generate unique referral code after 10 attempts");
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      const customer = await this.prisma.customer.create({
        data: {
          email,
          passwordHash,
          displayName: dto.displayName ?? null,
          referralCode: myReferralCode,
          invitedById: invitedById ?? null,
          status: "ACTIVE"
        }
      });

      const accessToken = this.tokenService.sign({
        customerId: customer.id,
        email: customer.email,
        tokenVersion: customer.tokenVersion
      });

      return {
        accessToken,
        customer: sanitizeCustomer(customer)
      };
    } catch (err: any) {
      // Unique constraint violation on email
      if (err?.code === "P2002" || err?.message?.includes("Unique constraint")) {
        throw new ConflictException({
          error: "EMAIL_TAKEN",
          message: "An account with this email already exists"
        });
      }
      throw err;
    }
  }

  async login(dto: { email: string; password: string }) {
    const email = dto.email.toLowerCase().trim();

    const customer = await this.prisma.customer.findUnique({
      where: { email }
    });

    // Same error for unknown email and wrong password — no enumeration
    if (!customer) {
      throw new UnauthorizedException({
        error: "INVALID_CREDENTIALS",
        message: "Invalid email or password"
      });
    }

    const valid = await bcrypt.compare(dto.password, customer.passwordHash);

    if (!valid) {
      throw new UnauthorizedException({
        error: "INVALID_CREDENTIALS",
        message: "Invalid email or password"
      });
    }

    if (customer.status === "DISABLED") {
      throw new ForbiddenException({
        error: "ACCOUNT_DISABLED",
        message: "This account has been disabled"
      });
    }

    const accessToken = this.tokenService.sign({
      customerId: customer.id,
      email: customer.email,
      tokenVersion: customer.tokenVersion
    });

    return {
      accessToken,
      customer: sanitizeCustomer(customer)
    };
  }

  async changePassword(
    customerId: string,
    currentPassword: string,
    newPassword: string
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    const valid = await bcrypt.compare(currentPassword, customer.passwordHash);
    if (!valid) {
      throw new UnauthorizedException({
        error: "INVALID_CREDENTIALS",
        message: "Current password is incorrect"
      });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Increment tokenVersion to revoke ALL outstanding tokens
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        passwordHash: newHash,
        tokenVersion: { increment: 1 }
      }
    });

    return { ok: true };
  }

  async refresh(customerId: string, currentTokenVersion: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    // Use the current (potentially refreshed) tokenVersion
    const accessToken = this.tokenService.sign({
      customerId: customer.id,
      email: customer.email,
      tokenVersion: customer.tokenVersion
    });

    return { accessToken };
  }

  async getProfile(customerId: string): Promise<CustomerSanitized> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerified: true,
        referralCode: true,
        creditCents: true,
        status: true,
        createdAt: true
      }
    });

    if (!customer) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    return sanitizeCustomer(customer);
  }

  async updateProfile(customerId: string, displayName: string): Promise<CustomerSanitized> {
    const customer = await this.prisma.customer.update({
      where: { id: customerId },
      data: { displayName },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerified: true,
        referralCode: true,
        creditCents: true,
        status: true,
        createdAt: true
      }
    });

    return sanitizeCustomer(customer);
  }

  sanitize = sanitizeCustomer;
}
