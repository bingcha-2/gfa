import { Body, Controller, Headers, Post } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";
import { SessionTokenResolver } from "../token-server/session-token-resolver";
import { RosettaService } from "./rosetta.service";

// 白号登录号池的【客户端】接口(与 admin 控制台的 console/rosetta 分开)。
// 桌面端接管 claude.ai 时:
//   1. POST lease-session → 拿一个白号(sessionKey + 静态出口代理) 注入 MITM
//   2. 注入后实测能用/不能用 → POST report-session 回报,驱动号池 status
//
// 鉴权【订阅 only】:与主租号路径一致,session JWT 必须解析到一条有效订阅,否则拒。
// 文件卡(access-keys.json)在运行时根本解析不到(卡密字符串运行时凭证已移除),所以「没转
// 订阅就不让用」对白号借号也成立 —— 没订阅的请求直接被 sessionTokenResolver 挡掉。
@Public()
@Controller("app/lease/anthropic-web")
export class ClaudeSessionLeaseController {
  constructor(
    private readonly rosetta: RosettaService,
    private readonly sessionResolver: SessionTokenResolver,
  ) {}

  @Post("lease-session")
  async leaseSession(@Headers("authorization") auth: string, @Body() body: any) {
    const sub = await this.sessionResolver.resolve(extractBearer(auth), {});
    if (!sub.ok) {
      return { ok: false, code: sub.error, error: sub.message };
    }
    // 粘性绑定:把订阅 id(cardId)下传,让号池把"同一用户↔同一白号"固定下来 —— claude.ai 的
    // web 会话不耐受多人并发共享(会互相把 sessionKey 轮换作废),一号一用户从根上避开打架。
    return this.rosetta.leaseClaudeSession({ ...body, cardId: sub.cardId });
  }

  @Post("report-session")
  async reportSession(@Headers("authorization") auth: string, @Body() body: any) {
    // 回报也要求有效订阅,防无凭证者乱报污染白号 status。
    const sub = await this.sessionResolver.resolve(extractBearer(auth), {});
    if (!sub.ok) {
      return { ok: false, code: sub.error, error: sub.message };
    }
    return this.rosetta.reportClaudeSession(body);
  }

  @Post("rotate-session")
  async rotateSession(@Headers("authorization") auth: string, @Body() body: any) {
    // 与 report 同样要求有效订阅:防无凭证者乱推 sessionKey 覆盖好号。
    const sub = await this.sessionResolver.resolve(extractBearer(auth), {});
    if (!sub.ok) {
      return { ok: false, code: sub.error, error: sub.message };
    }
    return this.rosetta.rotateClaudeSession(body);
  }
}

function extractBearer(auth?: string): string {
  if (!auth) return "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}
