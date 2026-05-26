import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { All, Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { TokenServerHttpError, TokenServerService } from "./token-server.service";

@Public()
@Controller("remote-token")
export class TokenServerController {
  constructor(private readonly tokenServer: TokenServerService) {}

  @Get()
  root(@Res() response: any) {
    return response.status(200).json(this.tokenServer.getStatus());
  }

  @Get(":path")
  get(@Param("path") path: string, @Res() response: any) {
    if (path === "status" || path === "health") {
      return response.status(200).json(this.tokenServer.getStatus());
    }
    if (path === "announcement") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      return response.status(200).send(readAnnouncementText());
    }
    return response.status(404).json({ ok: false, error: "Not found" });
  }

  @Post("api/activate")
  async activate(@Req() request: any, @Body() body: any, @Res() response: any) {
    try {
      return response.status(200).json(this.tokenServer.activateAccessKey(request, body));
    } catch (error) {
      return response.status(500).json({
        success: false,
        code: "ACCOUNT_CARD_NOT_FOUND",
        message: error instanceof Error ? error.message : "Activation failed",
      });
    }
  }

  @Post(":path")
  async post(@Param("path") path: string, @Req() request: any, @Body() body: any, @Res() response: any) {
    try {
      switch (path) {
        case "lease-token":
          return response.status(200).json(await this.tokenServer.leaseToken(request, body));
        case "report-result":
          return response.status(200).json(await this.tokenServer.reportResult(request, body));
        case "sr":
          return response.status(200).json(await this.tokenServer.shadowReport(request, body));
        case "reload-access-keys":
          return response.status(200).json(this.tokenServer.reloadAccessKeys());
        case "reload-accounts":
          return response.status(200).json({ ok: true, status: this.tokenServer.getStatus() });
        case "announcement":
          writeAnnouncementText(String(body?.text || ""));
          return response.status(200).json({ success: true, text: String(body?.text || "").trim() });
        default:
          return response.status(404).json({ ok: false, error: "Not found" });
      }
    } catch (error) {
      if (error instanceof TokenServerHttpError) {
        return response.status(error.statusCode).json(error.toBody());
      }
      return response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Token server error",
      });
    }
  }

  @All("*path")
  fallback(@Res() response: any) {
    return response.status(404).json({ ok: false, error: "Not found" });
  }
}

function readAnnouncementText() {
  if (process.env.BCAI_ANNOUNCEMENT) return process.env.BCAI_ANNOUNCEMENT;
  const dataDir = process.env.ROSETTA_DATA_DIR || (
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Antigravity", "rosetta")
      : path.resolve(process.cwd(), "data")
  );
  try {
    return fs.readFileSync(path.join(dataDir, "announcement.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

function writeAnnouncementText(text: string) {
  const dataDir = announcementDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "announcement.txt"), text.trim(), "utf8");
}

function announcementDataDir() {
  return process.env.ROSETTA_DATA_DIR || (
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Antigravity", "rosetta")
      : path.resolve(process.cwd(), "data")
  );
}
