import { Body, Controller, Post } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { IsEmail, IsString } from "class-validator";
import { Queue } from "bullmq";

import { QUEUE_NAMES } from "@gfa/shared";
import { Roles } from "./auth/roles.decorator";

class EnqueueInviteDto {
  @IsString()
  orderId!: string;

  @IsString()
  familyGroupId!: string;

  @IsString()
  accountId!: string;

  @IsEmail()
  userEmail!: string;
}

@Controller("debug")
@Roles("ADMIN")
export class QueueController {
  constructor(
    @InjectQueue(QUEUE_NAMES.invite)
    private readonly inviteQueue: Queue
  ) {}

  @Post("enqueue-invite")
  async enqueueInvite(@Body() body: EnqueueInviteDto) {
    const job = await this.inviteQueue.add("invite-member", body, {
      removeOnComplete: 100,
      removeOnFail: 1000
    });

    return {
      queued: true,
      jobId: job.id
    };
  }
}
