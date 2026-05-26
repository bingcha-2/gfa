const API_BASE = "https://hero-sms.com/stubs/handler_api.php";

const HERO_SMS_SERVICE_GOOGLE = "go";
const HERO_SMS_COUNTRIES = {
  indonesia: 6,
  india: 22,
  russia: 0,
  philippines: 4,
  vietnam: 10,
  malaysia: 7,
  myanmar: 35,
  thailand: 52,
  nigeria: 19,
  brazil: 73,
  usa: 12,
};

class HeroSmsClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async request(params) {
    const url = new URL(API_BASE);
    url.searchParams.set("api_key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    return (await res.text()).trim();
  }

  async getBalance() {
    const raw = await this.request({ action: "getBalance" });
    if (raw.startsWith("ACCESS_BALANCE:")) return parseFloat(raw.split(":")[1]);
    if (raw === "BAD_KEY") throw new Error("API Key 无效");
    throw new Error(`查询余额失败: ${raw}`);
  }

  async buyNumber(service = HERO_SMS_SERVICE_GOOGLE, country = HERO_SMS_COUNTRIES.indonesia, maxPrice = 0.5) {
    const raw = await this.request({ action: "getNumber", service, country, maxPrice });
    if (raw.startsWith("ACCESS_NUMBER:")) {
      const parts = raw.split(":");
      return { activationId: parts[1], phoneNumber: parts[2] };
    }
    if (raw === "NO_NUMBERS") throw new Error("当前无可用号码");
    if (raw === "NO_BALANCE") throw new Error("hero-sms 余额不足");
    if (raw === "BAD_KEY") throw new Error("API Key 无效");
    throw new Error(`购买号码失败: ${raw}`);
  }

  async setReady(activationId) {
    await this.request({ action: "setStatus", id: activationId, status: 1 }).catch(() => {});
  }

  async getStatus(activationId) {
    const raw = await this.request({ action: "getStatus", id: activationId });
    if (raw.startsWith("STATUS_OK:")) return { status: "ok", code: raw.split(":")[1] };
    if (raw === "STATUS_WAIT_CODE" || raw === "STATUS_WAIT_RETRY" || raw === "STATUS_WAIT_RESEND") return { status: "waiting" };
    if (raw === "STATUS_CANCEL") return { status: "cancelled" };
    return { status: "unknown" };
  }

  async cancelNumber(activationId) {
    await this.request({ action: "setStatus", id: activationId, status: 8 }).catch(() => {});
  }

  async completeNumber(activationId) {
    await this.request({ action: "setStatus", id: activationId, status: 6 }).catch(() => {});
  }

  async waitForCode(activationId, timeoutMs = 120000, pollMs = 3000) {
    await this.setReady(activationId).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { status, code } = await this.getStatus(activationId);
        if (status === "ok" && code) return code;
        if (status === "cancelled") return null;
      } catch (e) {}
      await new Promise(r => setTimeout(r, pollMs));
    }
    return null;
  }

  async buyAndWait(options) {
    const {
      service = HERO_SMS_SERVICE_GOOGLE,
      country = HERO_SMS_COUNTRIES.indonesia,
      maxPrice = 0.5,
      timeoutMs = 120000,
      maxRetries = 5,
      onNumberReady,
      onBeforeRetry,
    } = options;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let activation = null;
      try {
        activation = await this.buyNumber(service, country, maxPrice);
      } catch (e) {
        if (e.message.includes("余额不足")) throw e;
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      try {
        await onNumberReady(activation.phoneNumber);
        const code = await this.waitForCode(activation.activationId, timeoutMs);
        if (code) {
          return { code, phoneNumber: activation.phoneNumber, activationId: activation.activationId };
        }
        await this.cancelNumber(activation.activationId);
        if (onBeforeRetry) await onBeforeRetry().catch(() => {});
      } catch (e) {
        if (activation) await this.cancelNumber(activation.activationId);
        throw e;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    return null;
  }
}

module.exports = { HeroSmsClient, HERO_SMS_COUNTRIES };
