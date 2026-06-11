import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";

import { Public } from "../../../shared/auth/public.decorator";
import { RemoteCodexHttpError, RemoteCodexService } from "../service/remote-codex.service";

@Public()
@Controller(["remote-codex", "app/lease/codex"])
export class RemoteCodexController {
  constructor(private readonly remoteCodex: RemoteCodexService) {}

  @Get()
  root(@Res() response: any) {
    return response.status(200).json(this.remoteCodex.getStatus());
  }

  @Get(":path")
  get(@Param("path") pathName: string, @Res() response: any) {
    if (pathName === "status" || pathName === "health") {
      return response.status(200).json(this.remoteCodex.getStatus());
    }
    return response.status(404).json({ ok: false, error: "Not found" });
  }

  @Post("api/activate")
  async activate(@Req() request: any, @Body() body: any, @Res() response: any) {
    try {
      return response.status(200).json(await this.remoteCodex.activateAccessKey(request, body));
    } catch (error) {
      return response.status(500).json({
        success: false,
        code: "ACCOUNT_CARD_NOT_FOUND",
        message: error instanceof Error ? error.message : "Activation failed",
      });
    }
  }

  @Post(":path")
  async post(@Param("path") pathName: string, @Req() request: any, @Body() body: any, @Res() response: any) {
    try {
      switch (pathName) {
        case "lease-token":
          return response.status(200).json(await this.remoteCodex.leaseToken(request, body));
        case "report-result":
          return response.status(200).json(await this.remoteCodex.reportResult(request, body));
        case "reload-access-keys":
          return response.status(200).json(this.remoteCodex.reloadAccessKeys());
        case "reload-accounts":
          return response.status(200).json({ ok: true, status: this.remoteCodex.getStatus() });
        default:
          return response.status(404).json({ ok: false, error: "Not found" });
      }
    } catch (error) {
      if (error instanceof RemoteCodexHttpError) {
        return response.status(error.statusCode).json(error.toBody());
      }
      return response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Remote Codex error",
      });
    }
  }
}
