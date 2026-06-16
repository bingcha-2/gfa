import { Module } from "@nestjs/common";

import { LlmClient } from "./llm.client";
import { EmbeddingClient } from "./embedding.client";
import { loadSupportEmbedConfig, loadSupportLlmConfig } from "./llm.config";

/**
 * SupportLlmModule — 提供+导出 LlmClient(OpenAI 兼容客户端)。
 * 供客服 agent(对话)与知识提炼(后台)共用同一份 env 配置。
 *
 * 用 useFactory 构造:LlmClient 构造函数带一个可选 config 形参(便于单测注入),
 * 若交给 Nest 按类型注入会把它当依赖解析而启动失败 —— 工厂在组合根显式读 env。
 */
@Module({
  providers: [
    {
      provide: LlmClient,
      useFactory: () => new LlmClient(loadSupportLlmConfig()),
    },
    {
      provide: EmbeddingClient,
      useFactory: () => new EmbeddingClient(loadSupportEmbedConfig()),
    },
  ],
  exports: [LlmClient, EmbeddingClient],
})
export class SupportLlmModule {}
