import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendMailResult {
  ok: boolean;
}

/**
 * Hard-coded production SMTP defaults (QQ 邮箱).
 *
 * Any matching env var overrides the corresponding field, so a deployment can
 * point at a different mailbox without touching code. Disabled under
 * NODE_ENV=test (see createTransport) so unit tests never connect for real.
 *
 * ⚠️ SMTP_PASS below is a QQ Mail authorization code — treat it as a SECRET.
 * It grants send (and IMAP/POP) access to this mailbox. Keep this repository
 * private. If it could ever leak, move these values to env/secret storage and
 * rotate the code in QQ Mail → 设置 → 账号 → POP3/IMAP/SMTP.
 */
const FALLBACK_SMTP = {
  host: "smtp.qq.com",
  port: 465,
  secure: true,
  user: "3211141074@qq.com",
  pass: "xchdkwuzqyjtdfhe",
  // 显示名用 bcai.lol。⚠️ <> 里的地址必须等于 user（QQ 个人邮箱 SMTP 只允许用
  // 登录账号本身发信）；换成 xxx@bcai.lol 会被 QQ 拒收。要让地址也变 @bcai.lol，
  // 需改用 bcai.lol 域名邮箱/企业邮箱，并用 MAIL_FROM 覆盖。
  from: "bcai.lol <3211141074@qq.com>"
} as const;

/**
 * MailService
 *
 * Reads transport config from env at first send (lazy init), falling back to
 * FALLBACK_SMTP when a var is absent. Any env var present overrides its default.
 *
 * no-op mode (logs instead of sending) kicks in when there is no host at all:
 *   - NODE_ENV=test → fallback disabled, so unit tests never send, or
 *   - SMTP_HOST="" explicitly set → disable mail in a given environment.
 *
 * Transport errors are caught — auth flows must not 500 because SMTP hiccuped.
 *
 * DI-injectable transport factory: subclasses or tests can override
 * `createTransport()` to inject a fake/in-memory transport.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null | "noop" | undefined = undefined;

  /** Called lazily on first send. Override in tests to inject a fake transport. */
  protected createTransport(): Transporter | "noop" {
    // Hard-coded prod defaults, overridable per-field by env.
    // Disabled under NODE_ENV=test so unit tests never send for real.
    const fallback = process.env.NODE_ENV === "test" ? null : FALLBACK_SMTP;

    // SMTP_HOST="" (explicit empty string) forces no-op in any environment.
    const host = process.env.SMTP_HOST ?? fallback?.host;
    if (!host) {
      return "noop";
    }

    const port = process.env.SMTP_PORT
      ? parseInt(process.env.SMTP_PORT, 10)
      : (fallback?.port ?? 587);
    const secure =
      process.env.SMTP_SECURE != null
        ? process.env.SMTP_SECURE === "true"
        : (fallback?.secure ?? false);
    const user = process.env.SMTP_USER ?? fallback?.user;
    const pass = process.env.SMTP_PASS ?? fallback?.pass;

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined
    });
  }

  private getTransport(): Transporter | "noop" {
    if (this.transporter === undefined) {
      this.transporter = this.createTransport();
    }
    return this.transporter as Transporter | "noop";
  }

  private get from(): string {
    return process.env.MAIL_FROM ?? FALLBACK_SMTP.from;
  }

  async sendMail(opts: SendMailOptions): Promise<SendMailResult> {
    const transport = this.getTransport();

    if (transport === "noop") {
      this.logger.log(`[mail] (noop) to=${opts.to} subject=${opts.subject}`);
      this.logger.debug(`[mail] (noop) body:\n${opts.text}`);
      return { ok: true };
    }

    try {
      await transport.sendMail({
        from: this.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html
      });
      return { ok: true };
    } catch (err: any) {
      this.logger.error(`[mail] sendMail failed to=${opts.to}: ${err?.message}`);
      return { ok: false };
    }
  }
}
