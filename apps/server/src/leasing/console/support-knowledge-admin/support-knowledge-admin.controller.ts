import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ConsoleJwtGuard } from "../../../shared/auth/console-jwt.guard";
import { Roles } from "../../../shared/auth/roles.decorator";
import { SupportKnowledgeAdminService } from "./support-knowledge-admin.service";
import {
  CreateKnowledgeDto,
  DistillTicketsDto,
  MergeKnowledgeDto,
  UpdateKnowledgeDto,
} from "./dto/support-knowledge-admin.dto";

/**
 * 后台客服知识管理(/api/console/support-knowledge/*)。
 *
 *   GET    .                — 列表(?status=…;不传=全部)
 *   POST   .                — 手动新增一条知识(body{question,answer,category?,publish?})
 *   POST   ./distill        — 勾选工单提炼(body{ticketIds[]})
 *   POST   ./merge          — 手动合并(body{primaryId, otherIds[]})
 *   PATCH  ./:id            — 编辑 question/answer/category
 *   POST   ./:id/publish    — 发布(合并建议则更新目标并归档建议)
 *   DELETE ./:id            — 归档
 */
@Controller("console/support-knowledge")
@UseGuards(ConsoleJwtGuard)
@Roles("ADMIN", "OPERATIONS")
export class SupportKnowledgeAdminController {
  constructor(private readonly svc: SupportKnowledgeAdminService) {}

  @Get()
  list(@Query("status") status?: string) {
    return this.svc.list(status);
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateKnowledgeDto) {
    return this.svc.create(dto);
  }

  @Post("distill")
  @HttpCode(200)
  distill(@Body() dto: DistillTicketsDto) {
    return this.svc.distillTickets(dto.ticketIds);
  }

  @Post("merge")
  @HttpCode(200)
  merge(@Body() dto: MergeKnowledgeDto) {
    return this.svc.merge(dto.primaryId, dto.otherIds);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.svc.update(id, dto);
  }

  @Post(":id/publish")
  @HttpCode(200)
  publish(@Param("id") id: string) {
    return this.svc.publish(id);
  }

  @Delete(":id")
  @HttpCode(200)
  async archive(@Param("id") id: string) {
    await this.svc.archive(id);
    return { ok: true };
  }
}
