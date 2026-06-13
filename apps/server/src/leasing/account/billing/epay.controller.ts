/**
 * epay.controller.ts — server-to-server payment callback from 彩虹易支付 zhunfu V2.
 *
 * Route: GET|POST /api/epay/notify
 *
 * @Public() with NO customer guard — it's the gateway's async notify. zhunfu V2
 * sends the notify as a **GET**(params in the query string); we also accept POST
 * (form-encoded body, parsed by main.ts's urlencoded parser) for safety.
 *
 * Response: plain text "success" or "fail" (epay expects these exact strings).
 */
import { Controller, Get, Post, Req, Res } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { EpayCallbackService } from "./epay-callback.service";

@Public()
@Controller("epay")
export class EpayController {
  constructor(private readonly epayCallback: EpayCallbackService) {}

  @Get("notify")
  @Post("notify")
  async notify(@Req() req: any, @Res() res: any): Promise<void> {
    // V2 通知是 GET(参数在 query);POST 时取 urlencoded body。坏解析兜底 {}。
    const params: Record<string, string> =
      ((req.method === "GET" ? req.query : req.body) as Record<string, string>) ?? {};

    const result = await this.epayCallback.handleNotify(params);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(result);
  }
}
