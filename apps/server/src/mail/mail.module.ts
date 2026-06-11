import { Global, Module } from "@nestjs/common";
import { MailService } from "./mail.service";

/**
 * MailModule — global so any feature module can inject MailService
 * without explicitly importing MailModule.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService]
})
export class MailModule {}
