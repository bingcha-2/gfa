/**
 * mail.service.spec.ts
 *
 * Tests for MailService:
 *   1. no-op mode (SMTP_HOST unset): logs and resolves {ok:true}
 *   2. transport errors swallowed: returns {ok:false}, does not throw
 *   3. fake-transport mode: passes through to/subject/text correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Transporter } from "nodemailer";
import { MailService } from "../mail.service";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * MailService subclass that exposes a slot for injecting a fake transport.
 * Overrides createTransport() — the DI-injectable factory method.
 */
class TestableMailService extends MailService {
  // Set to a mock Transporter before sending. Null = use noop.
  fakeTransport: Transporter | null = null;

  protected override createTransport(): Transporter | "noop" {
    if (this.fakeTransport) {
      return this.fakeTransport;
    }
    return super.createTransport();
  }
}

function makeFakeTransport(
  sendMailImpl: (opts: any) => Promise<any> = async () => ({})
) {
  return {
    sendMail: vi.fn(sendMailImpl)
  } as unknown as Transporter;
}

// ── 1. no-op mode ─────────────────────────────────────────────────────────────

describe("MailService — no-op mode (SMTP_HOST unset)", () => {
  let originalSmtpHost: string | undefined;

  beforeEach(() => {
    originalSmtpHost = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
  });

  afterEach(() => {
    if (originalSmtpHost !== undefined) {
      process.env.SMTP_HOST = originalSmtpHost;
    } else {
      delete process.env.SMTP_HOST;
    }
  });

  it("returns {ok:true} in no-op mode", async () => {
    const svc = new TestableMailService();
    const result = await svc.sendMail({
      to: "user@test.com",
      subject: "Test Subject",
      text: "Hello world"
    });
    expect(result).toEqual({ ok: true });
  });

  it("does not throw in no-op mode", async () => {
    const svc = new TestableMailService();
    await expect(
      svc.sendMail({ to: "a@b.com", subject: "s", text: "t" })
    ).resolves.not.toThrow();
  });
});

// ── 2. transport errors swallowed ─────────────────────────────────────────────

describe("MailService — transport errors swallowed", () => {
  it("returns {ok:false} when transport throws", async () => {
    const svc = new TestableMailService();
    svc.fakeTransport = makeFakeTransport(async () => {
      throw new Error("SMTP connection refused");
    });

    const result = await svc.sendMail({
      to: "user@test.com",
      subject: "Test",
      text: "body"
    });

    expect(result).toEqual({ ok: false });
  });

  it("does not propagate transport errors (auth flows must not 500)", async () => {
    const svc = new TestableMailService();
    svc.fakeTransport = makeFakeTransport(async () => {
      throw new Error("Network error");
    });

    await expect(
      svc.sendMail({ to: "x@y.com", subject: "s", text: "t" })
    ).resolves.toEqual({ ok: false });
  });
});

// ── 3. fake-transport mode ────────────────────────────────────────────────────

describe("MailService — fake-transport mode", () => {
  it("passes to/subject/text through to transport", async () => {
    const svc = new TestableMailService();
    const fake = makeFakeTransport();
    svc.fakeTransport = fake;

    process.env.MAIL_FROM = "GFA <no-reply@bcai.lol>";

    await svc.sendMail({
      to: "recipient@test.com",
      subject: "Password Reset",
      text: "Click here: https://bcai.lol/reset?token=abc123"
    });

    expect((fake.sendMail as any).mock.calls.length).toBe(1);
    const call = (fake.sendMail as any).mock.calls[0][0];
    expect(call.to).toBe("recipient@test.com");
    expect(call.subject).toBe("Password Reset");
    expect(call.text).toContain("abc123");
  });

  it("returns {ok:true} on successful send", async () => {
    const svc = new TestableMailService();
    svc.fakeTransport = makeFakeTransport();

    const result = await svc.sendMail({
      to: "u@t.com",
      subject: "s",
      text: "t"
    });

    expect(result).toEqual({ ok: true });
  });

  it("includes html if provided", async () => {
    const svc = new TestableMailService();
    const fake = makeFakeTransport();
    svc.fakeTransport = fake;

    await svc.sendMail({
      to: "u@t.com",
      subject: "s",
      text: "plain text",
      html: "<b>html body</b>"
    });

    const call = (fake.sendMail as any).mock.calls[0][0];
    expect(call.html).toBe("<b>html body</b>");
  });
});
