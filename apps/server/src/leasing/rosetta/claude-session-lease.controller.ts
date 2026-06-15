import { Body, Controller, Headers, Post } from "@nestjs/common";

import { Public } from "../../shared/auth/public.decorator";
import { RosettaService } from "./rosetta.service";

// 白号登录号池的【客户端】接口(与 admin 控制台的 console/rosetta 分开)。
// 桌面端接管 claude.ai 时:
//   1. POST lease-session → 拿一个白号(sessionKey + 静态出口代理) 注入 MITM
//   2. 注入后实测能用/不能用 → POST report-session 回报,驱动号池 status
// 与其余 app/lease/* 一样 @Public()(自身鉴权靠卡密 Authorization: Bearer),
// 不走管理员后台网关。
@Public()
@Controller("app/lease/anthropic-web")
export class ClaudeSessionLeaseController {
  constructor(private readonly rosetta: RosettaService) {}

  @Post("lease-session")
  leaseSession(@Headers("authorization") auth: string, @Body() body: any) {
    // 轻量闸:必须带卡密。白号本身是稀缺资源,按订阅级别的精细放行可后续再接 access key store。
    const card = extractBearer(auth);
    if (!card) return { ok: false, error: "missing card credential" };
    return this.rosetta.leaseClaudeSession({ ...body, card });
  }

  @Post("report-session")
  reportSession(@Body() body: any) {
    return this.rosetta.reportClaudeSession(body);
  }
}

function extractBearer(auth?: string): string {
  if (!auth) return "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}
