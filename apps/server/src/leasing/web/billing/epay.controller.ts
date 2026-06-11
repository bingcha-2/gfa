/**
 * epay.controller.ts — server-to-server payment callback from 彩虹易支付.
 *
 * Route: POST /api/epay/notify
 *
 * This endpoint is @Public() with NO customer guard — it receives form-encoded
 * POST bodies from the epay gateway. Express's built-in urlencoded parser
 * handles the body (enabled in main.ts via app.useBodyParser or express default).
 *
 * Response: plain text "success" or "fail" (epay expects these exact strings).
 */
import { Controller, Post, Req, Res } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { EpayCallbackService } from "./epay-callback.service";

@Public()
@Controller("epay")
export class EpayController {
  constructor(private readonly epayCallback: EpayCallbackService) {}

  @Post("notify")
  async notify(@Req() req: any, @Res() res: any): Promise<void> {
    // body is parsed by express urlencoded middleware (enabled globally or per-app).
    // Defensively fall back to {} if parsing failed.
    const body: Record<string, string> = (req.body as Record<string, string>) ?? {};

    const result = await this.epayCallback.handleNotify(body);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(result);
  }
}
