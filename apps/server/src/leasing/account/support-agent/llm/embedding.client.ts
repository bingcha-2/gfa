import { Injectable } from "@nestjs/common";
import OpenAI from "openai";

import { loadSupportEmbedConfig, SupportEmbedConfig } from "./llm.config";

/**
 * EmbeddingClient —— 文本向量化(OpenAI 兼容 embeddings 接口),P3 语义检索用。
 * 未配齐 SUPPORT_EMBED_* 时 enabled=false,检索侧自动回退关键词。
 */
@Injectable()
export class EmbeddingClient {
  private readonly config: SupportEmbedConfig;
  private client: OpenAI | null = null;

  constructor(config?: SupportEmbedConfig) {
    this.config = config ?? loadSupportEmbedConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        baseURL: this.config.baseUrl,
        apiKey: this.config.apiKey,
      });
    }
    return this.client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.getClient().embeddings.create({
      model: this.config.model,
      input: texts,
    });
    return res.data.map((d) => d.embedding as number[]);
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    return v ?? [];
  }
}

/** 余弦相似度(向量为空或维度不符返回 0)。 */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
