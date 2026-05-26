import { Body, Controller, Get, Post, Query } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { RosettaService } from "./rosetta.service";

@Public()
@Controller("rosetta")
export class RosettaController {
  constructor(private readonly rosetta: RosettaService) {}

  @Get("access-keys")
  listAccessKeys(@Query("search") search?: string) {
    return this.rosetta.listAccessKeys({ search });
  }

  @Get("employees")
  listEmployees() {
    return this.rosetta.listEmployees();
  }

  @Get("accounts")
  listAccounts() {
    return this.rosetta.listAccounts();
  }

  @Post("add-account")
  addAccount(@Body() body: any) {
    return this.rosetta.addAccount(body);
  }

  @Post("toggle-account")
  toggleAccount(@Body() body: any) {
    return this.rosetta.toggleAccount(body);
  }

  @Post("delete-account")
  deleteAccount(@Body() body: any) {
    return this.rosetta.deleteAccount(body);
  }

  @Post("access-key")
  createAccessKey(@Body() body: any) {
    return this.rosetta.createAccessKey(body);
  }

  @Post("access-key-update")
  updateAccessKey(@Body() body: any) {
    return this.rosetta.updateAccessKey(body);
  }

  @Post("access-key-delete")
  deleteAccessKey(@Body() body: any) {
    return this.rosetta.deleteAccessKey(body);
  }

  @Get("throttle-config")
  getThrottleConfig() {
    return this.rosetta.getThrottleConfig();
  }

  @Post("throttle-config")
  saveThrottleConfig(@Body() body: any) {
    return this.rosetta.saveThrottleConfig(body);
  }
}
