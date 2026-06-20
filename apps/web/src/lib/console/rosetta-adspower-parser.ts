export type RosettaAdspowerCredential = {
  email: string;
  password: string;
  recoveryEmail?: string;
  totpSecret?: string;
  phones?: { phoneNumber: string; smsUrl: string }[];
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const totpRegex = /^[a-z2-7\s\-=]{16,}$/i;

function isTotpLike(value: string): boolean {
  return (
    /2fa\.live\/tok\//i.test(value) ||
    (totpRegex.test(value) && !/^\d{4}$/.test(value))
  );
}

export function parseCredentialLine(
  line: string
): RosettaAdspowerCredential | null {
  if (!line || !line.trim()) return null;

  const mainAndPhone = line.trim().split(/------/);
  const mainPart = (mainAndPhone[0] || "").trim();
  const phonePart = (mainAndPhone[1] || "").trim();

  const parts = mainPart
    .split(/-{3,}|\||\t/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const email = parts[0];
  const password = parts[1];

  if (!emailRegex.test(email)) return null;
  if (!password) return null;

  let recoveryEmail: string | undefined;
  let totpSecret: string | undefined;

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    if (!recoveryEmail && emailRegex.test(part)) {
      recoveryEmail = part;
    } else if (!totpSecret && isTotpLike(part)) {
      totpSecret = part;
    }
  }

  let phones: { phoneNumber: string; smsUrl: string }[] | undefined;
  if (phonePart) {
    const phoneParts = phonePart
      .split(/\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (phoneParts.length >= 2) {
      const phoneNumber = phoneParts[0];
      const smsUrl = phoneParts.slice(1).join("|");
      phones = [{ phoneNumber, smsUrl }];
    }
  }

  return { email, password, recoveryEmail, totpSecret, phones };
}
