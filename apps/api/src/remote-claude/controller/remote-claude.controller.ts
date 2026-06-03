import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";

import { Public } from "../../auth/public.decorator";
import { RemoteClaudeHttpError, RemoteClaudeService } from "../service/remote-claude.service";

@Public()
@Controller("remote-claude")
export class RemoteClaudeController {
  constructor(private readonly remoteClaude: RemoteClaudeService) {}

  @Get()
  root(@Res() response: any) {
    return response.status(200).json(this.remoteClaude.getStatus());
  }

  @Get(":path")
  get(@Param("path") pathName: string, @Res() response: any) {
    if (pathName === "status" || pathName === "health") {
      return response.status(200).json(this.remoteClaude.getStatus());
    }
    return response.status(404).json({ ok: false, error: "Not found" });
  }

  @Post("api/activate")
  activate(@Req() request: any, @Body() body: any, @Res() response: any) {
    try {
      return response.status(200).json(this.remoteClaude.activateAccessKey(request, body));
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
          return response.status(200).json(await this.remoteClaude.leaseToken(request, body));
        case "report-result":
          return response.status(200).json(await this.remoteClaude.reportResult(request, body));
        case "reload-access-keys":
          return response.status(200).json(this.remoteClaude.reloadAccessKeys());
        case "reload-accounts":
          return response.status(200).json({ ok: true, status: this.remoteClaude.getStatus() });
        default:
          return response.status(404).json({ ok: false, error: "Not found" });
      }
    } catch (error) {
      if (error instanceof RemoteClaudeHttpError) {
        return response.status(error.statusCode).json(error.toBody());
      }
      return response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Remote Claude error",
      });
    }
  }
}
