import { describe, expect, it } from "vitest";

import { parseCredentialLine } from "@/lib/console/rosetta-adspower-parser";

describe("parseCredentialLine", () => {
  it("parses pipe separated Google credentials", () => {
    const parsed = parseCredentialLine(
      "user@example.com|password123|recover@example.com|abcd2345efghklmn"
    );

    expect(parsed).toEqual({
      email: "user@example.com",
      password: "password123",
      recoveryEmail: "recover@example.com",
      totpSecret: "abcd2345efghklmn",
      phones: undefined,
    });
  });

  it("parses dash separated credentials with extra metadata fields", () => {
    const parsed = parseCredentialLine(
      "dash-user@example.com----dash-pass----dash-recover@example.com----eb72apeomlbxmollixuom445bq5hpfzm----2023----United States"
    );

    expect(parsed).toEqual({
      email: "dash-user@example.com",
      password: "dash-pass",
      recoveryEmail: "dash-recover@example.com",
      totpSecret: "eb72apeomlbxmollixuom445bq5hpfzm",
      phones: undefined,
    });
  });

  it("keeps the six-dash phone suffix separate from dash separated credentials", () => {
    const parsed = parseCredentialLine(
      "phone-user@example.com----phone-pass------+15551234567|https://sms.example/inbox?id=abc|next"
    );

    expect(parsed).toEqual({
      email: "phone-user@example.com",
      password: "phone-pass",
      recoveryEmail: undefined,
      totpSecret: undefined,
      phones: [
        {
          phoneNumber: "+15551234567",
          smsUrl: "https://sms.example/inbox?id=abc|next",
        },
      ],
    });
  });
});
