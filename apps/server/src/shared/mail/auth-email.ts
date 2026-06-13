/**
 * Branded transactional-email templates (password reset / email verification).
 *
 * Visual language mirrors the marketing site (apps/web .../marketing.css):
 * warm off-white canvas, white card, near-black warm ink, and the brand
 * orange `--primary` (oklch(0.646 0.196 41) ≈ #E4570B) for the CTA.
 *
 * Email-client constraints honoured: table layout, all-inline styles, hex
 * colours only (no oklch/var), a bullet-proof button (bgcolor + padding-on-<a>),
 * and a plain-text part for deliverability / non-HTML clients.
 */

const BRAND = "冰茶AI";

interface AuthEmailContent {
  /** Hidden inbox-preview line (first ~90 chars shown next to the subject). */
  preheader: string;
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
  /** Expiry + "ignore if not you" reassurance. */
  notice: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

function renderAuthEmail(c: AuthEmailContent): { html: string; text: string } {
  const text =
    `${c.intro}\n\n` +
    `${c.ctaLabel}：\n${c.ctaUrl}\n\n` +
    `${c.notice}\n\n` +
    `— ${BRAND}`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${c.heading}</title>
</head>
<body style="margin:0;padding:0;background:#FBFAF8;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${c.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBFAF8;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:#FFFFFF;border:1px solid #ECE7E0;border-radius:16px;overflow:hidden;font-family:'PingFang SC','Hiragino Sans GB','Noto Sans SC',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td style="padding:24px 32px 20px;border-bottom:1px solid #F0ECE6;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td style="vertical-align:middle;">
                  <span style="display:inline-block;width:30px;height:30px;background:#E4570B;border-radius:8px;color:#FFFFFF;font-size:16px;font-weight:700;text-align:center;line-height:30px;">冰</span>
                </td>
                <td style="vertical-align:middle;padding-left:10px;font-size:17px;font-weight:700;color:#2C2722;letter-spacing:-0.01em;">${BRAND}</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px 8px;">
              <h1 style="margin:0 0 12px;font-size:21px;line-height:1.35;font-weight:700;color:#2C2722;">${c.heading}</h1>
              <p style="margin:0 0 26px;font-size:14.5px;line-height:1.75;color:#5A534A;">${c.intro}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td bgcolor="#DB5009" style="border-radius:10px;background-color:#DB5009;background-image:linear-gradient(135deg,#E85D10,#C9450A);">
                  <a href="${c.ctaUrl}" target="_blank" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:600;line-height:1;color:#FFFFFF;text-decoration:none;border-radius:10px;">${c.ctaLabel} →</a>
                </td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 4px;">
              <p style="margin:0 0 6px;font-size:12.5px;line-height:1.6;color:#8A8175;">按钮打不开？把下面的链接复制到浏览器地址栏打开：</p>
              <p style="margin:0;font-size:12.5px;line-height:1.6;word-break:break-all;"><a href="${c.ctaUrl}" target="_blank" style="color:#C0410A;text-decoration:none;">${c.ctaUrl}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 28px;">
              <p style="margin:0;font-size:12.5px;line-height:1.7;color:#A39A8D;">${c.notice}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background:#F7F5F2;border-top:1px solid #F0ECE6;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#A39A8D;">${BRAND} · 本邮件由系统自动发送，请勿直接回复</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text };
}

/** Password-reset email (link valid 30 min). */
export function passwordResetEmail(link: string): BuiltEmail {
  const { html, text } = renderAuthEmail({
    preheader: "点击重置你的冰茶AI登录密码，链接 30 分钟内有效。",
    heading: "重置你的密码",
    intro: "我们收到了重置你冰茶AI账号密码的请求。点击下面的按钮，设置一个新的登录密码：",
    ctaLabel: "重置密码",
    ctaUrl: link,
    notice:
      "为安全起见，该链接将在 30 分钟后失效。如果这不是你本人的操作，请忽略此邮件 —— 你的密码不会发生任何更改。"
  });
  return { subject: "重置你的冰茶AI密码", html, text };
}

/** Email-verification email (link valid 24 h). */
export function verifyEmailEmail(link: string): BuiltEmail {
  const { html, text } = renderAuthEmail({
    preheader: "验证你的邮箱以完成冰茶AI账号激活，链接 24 小时内有效。",
    heading: "验证你的邮箱",
    intro: "欢迎加入冰茶AI！请点击下面的按钮验证你的邮箱地址，完成账号激活：",
    ctaLabel: "验证邮箱",
    ctaUrl: link,
    notice: "该链接将在 24 小时后失效。如果你没有注册过冰茶AI，请忽略此邮件。"
  });
  return { subject: "验证你的冰茶AI邮箱", html, text };
}
