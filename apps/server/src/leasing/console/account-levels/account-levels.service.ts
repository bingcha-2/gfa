import * as path from "path";
import { Injectable, Optional } from "@nestjs/common";

import { defaultRemoteAccessDataDir } from "../../remote-access/data-dir";
import { readJson } from "../../rosetta/lib/store";

/** 御三家产品 → 账号池文件名(与 AccessKeyService.poolFileFor 一致)。 */
const POOL_FILE_BY_PRODUCT: Record<string, string> = {
  anthropic: "anthropic-accounts.json",
  codex: "codex-accounts.json",
  antigravity: "accounts.json",
};

export interface AccountLevelsResult {
  ok: boolean;
  product: string;
  levels: string[];
}

/**
 * 列出某产品账号池里实际存在的会员等级(planType)去重列表,供 console 套餐配置页绑定线
 * 等级从下拉里选 —— 账号池里没有的等级选不了,使「console 档名 ↔ account.planType ↔ 绑定
 * 匹配」天然一致,根除"档名对不上→绑定失败"(spec §3 line 111「等级档名以实际可绑的号为准」)。
 *
 * 纯读:只读账号池 JSON,不写、不改任何状态。
 */
@Injectable()
export class AccountLevelsService {
  // @Optional():dataDir 不是 DI 依赖,而是「读账号池目录」的可注入默认(测试可传 tmp 目录)。
  // 无 @Optional 时 NestJS 会把 string 参数当依赖去解析 String provider → 启动期解析失败(应用起不来)。
  constructor(@Optional() private readonly dataDir: string = defaultRemoteAccessDataDir()) {}

  listLevels(product: string): AccountLevelsResult {
    const fileName = POOL_FILE_BY_PRODUCT[product];
    if (!fileName) return { ok: false, product, levels: [] };

    const pool = readJson(path.join(this.dataDir, fileName), { accounts: [] });
    const accounts = Array.isArray(pool.accounts) ? pool.accounts : [];

    // 去重 + 排序:trim 后非空才算;排序让列表稳定(可断言、UI 顺序一致)。
    const seen = new Set<string>();
    for (const account of accounts) {
      const level = String(account?.planType || "").trim();
      if (level) seen.add(level);
    }
    return { ok: true, product, levels: [...seen].sort() };
  }
}
