import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as bcrypt from "bcrypt";
import { CustomerEmailTokenPurpose } from "@prisma/client";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { CustomerTokenService } from "./customer-token.service";
import { CustomerEmailTokenService } from "./customer-email-token.service";
import { MailService } from "../../../shared/mail/mail.service";
import { passwordResetEmail, verifyEmailEmail } from "../../../shared/mail/auth-email";

// bcrypt cost factor — 10 as spec'd
const BCRYPT_ROUNDS = 10;

// Referral code alphabet: A-Z plus 2-9 — Crockford-style: intentionally excludes I/O
// (visually ambiguous with 1 and 0) to prevent transcription errors by users.
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

function webBaseUrl(): string {
  // 默认指向本地 web（dev）；生产由 WEB_BASE_URL 注入账号中心子域 my.bcai.lol
  // （见 .env.example / docs/NAMING.md）。不在源码里写死生产域名。
  return process.env.WEB_BASE_URL ?? "http://localhost:3000";
}

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: CustomerTokenService,
    private readonly emailTokenService: CustomerEmailTokenService,
    private readonly mailService: MailService
  ) {}

  async register(dto: {
    email: string;
    password: string;
    displayName?: string;
    referralCode?: string;
  }) {
    const email = dto.email.toLowerCase().trim();

    // Preflight uniqueness check — avoid burning a bcrypt hash (~100ms) on a
    // doomed registration. The P2002 catch below stays as the race-safe backstop.
    const taken = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true }
    });
    if (taken) {
      throw new ConflictException({
        error: "EMAIL_TAKEN",
        message: "An account with this email already exists"
      });
    }

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

      // Best-effort: send verification email — must not block or fail registration
      this.sendVerificationEmailBestEffort(customer.id, customer.email);

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

  /** Fire-and-forget: issue a VERIFY_EMAIL token and send the email. Never throws. */
  private sendVerificationEmailBestEffort(customerId: string, email: string): void {
    const ttlMs = 24 * 60 * 60 * 1000; // 24h
    // Use Promise chaining — intentionally not awaited by the caller
    this.emailTokenService
      .issueToken(customerId, CustomerEmailTokenPurpose.VERIFY_EMAIL, ttlMs)
      .then((plaintext) => {
        const link = `${webBaseUrl()}/account/verify-email?token=${plaintext}`;
        const mail = verifyEmailEmail(link);
        return this.mailService.sendMail({
          to: email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html
        });
      })
      .catch((err) => {
        this.logger.warn(
          `[customer-auth] best-effort verify email failed for ${email}: ${err?.message}`
        );
      });
  }

  /**
   * Validate email+password and return the RAW Customer row.
   *
   * Shared by web login and app login — app login needs id/email/tokenVersion/
   * displayName to sign a device-bound token without a second findUnique
   * (which would race with a concurrent password change).
   *
   * Throws the same structured errors as login():
   *   unknown email / wrong password → 401 INVALID_CREDENTIALS (no enumeration)
   *   DISABLED account → 403 ACCOUNT_DISABLED
   */
  async validateCredentials(email: string, password: string) {
    const normalizedEmail = email.toLowerCase().trim();

    const customer = await this.prisma.customer.findUnique({
      where: { email: normalizedEmail }
    });

    // Same error for unknown email and wrong password — no enumeration
    if (!customer) {
      throw new UnauthorizedException({
        error: "INVALID_CREDENTIALS",
        message: "Invalid email or password"
      });
    }

    const valid = await bcrypt.compare(password, customer.passwordHash);

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

    return customer;
  }

  async login(dto: { email: string; password: string }) {
    const customer = await this.validateCredentials(dto.email, dto.password);

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

  async refresh(customerId: string) {
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

  /**
   * POST web/auth/forgot-password
   * Always returns {ok:true} to prevent account enumeration.
   * If customer exists: issues RESET_PASSWORD token (30min) + sends mail.
   */
  async forgotPassword(email: string): Promise<{ ok: true }> {
    const normalizedEmail = email.toLowerCase().trim();
    const customer = await this.prisma.customer.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true }
    });

    if (customer) {
      // Await token persistence, but treat mail as fire-and-forget on error
      const plaintext = await this.emailTokenService.issueToken(
        customer.id,
        CustomerEmailTokenPurpose.RESET_PASSWORD,
        30 * 60 * 1000
      );

      const link = `${webBaseUrl()}/account/reset?token=${plaintext}`;
      const mail = passwordResetEmail(link);
      // Fire-and-forget the mail send — do not await failure into the response
      this.mailService
        .sendMail({
          to: customer.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html
        })
        .catch((err) => {
          this.logger.warn(
            `[customer-auth] forgot-password mail failed for ${customer.email}: ${err?.message}`
          );
        });
    }

    return { ok: true };
  }

  /**
   * POST web/auth/reset-password
   * Consumes a RESET_PASSWORD token and sets a new password.
   * Increments tokenVersion to revoke all existing sessions.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    const customerId = await this.emailTokenService.consumeToken(
      token,
      CustomerEmailTokenPurpose.RESET_PASSWORD
    );

    if (!customerId) {
      throw new BadRequestException({
        error: "INVALID_TOKEN",
        message: "链接无效或已过期"
      });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        passwordHash: newHash,
        tokenVersion: { increment: 1 }
      }
    });

    return { ok: true };
  }

  /**
   * POST web/auth/request-verify-email (requires CustomerJwtGuard)
   * Issues a VERIFY_EMAIL token and sends a verification email.
   * If already verified, returns {ok:true, alreadyVerified:true} immediately.
   */
  async requestVerifyEmail(customerId: string): Promise<{ ok: true; alreadyVerified?: true }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, email: true, emailVerified: true }
    });

    if (!customer) {
      throw new UnauthorizedException({
        error: "SESSION_INVALID",
        message: "Customer not found"
      });
    }

    if (customer.emailVerified) {
      return { ok: true, alreadyVerified: true };
    }

    const plaintext = await this.emailTokenService.issueToken(
      customer.id,
      CustomerEmailTokenPurpose.VERIFY_EMAIL,
      24 * 60 * 60 * 1000 // 24h
    );

    const link = `${webBaseUrl()}/account/verify-email?token=${plaintext}`;
    const mail = verifyEmailEmail(link);
    this.mailService
      .sendMail({
        to: customer.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html
      })
      .catch((err) => {
        this.logger.warn(
          `[customer-auth] request-verify-email mail failed for ${customer.email}: ${err?.message}`
        );
      });

    return { ok: true };
  }

  /**
   * POST web/auth/verify-email
   * Consumes a VERIFY_EMAIL token and marks the customer's email as verified.
   */
  async verifyEmail(token: string): Promise<{ ok: true }> {
    const customerId = await this.emailTokenService.consumeToken(
      token,
      CustomerEmailTokenPurpose.VERIFY_EMAIL
    );

    if (!customerId) {
      throw new BadRequestException({
        error: "INVALID_TOKEN",
        message: "链接无效或已过期"
      });
    }

    await this.prisma.customer.update({
      where: { id: customerId },
      data: { emailVerified: true }
    });

    return { ok: true };
  }
}
