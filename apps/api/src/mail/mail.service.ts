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
 * MailService
 *
 * Reads transport config from env at first send (lazy init).
 * When SMTP_HOST is unset → no-op mode: logs to/subject/text and returns {ok:true}.
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
    const host = process.env.SMTP_HOST;
    if (!host) {
      return "noop";
    }

    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const secure = process.env.SMTP_SECURE === "true";
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

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
    return process.env.MAIL_FROM ?? "GFA <no-reply@bcai.lol>";
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
