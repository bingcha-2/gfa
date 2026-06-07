# 批量 2FA 录入格式完善与 Google 登录多状态支持 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善批量更新 2FA (TOTP) 功能的录入解析格式，并增强 Google 自动登录脚本以支持“辅助邮箱确认验证”以及允许手动解决 CAPTCHA / 手机验证。

**Architecture:**
1. 在 `bulk-2fa.service.ts` 中引入内容特征启发式解析（基于 `@` 字符区分辅助邮箱与 TOTP 密钥）以及合并换行行的多行支持。
2. 在 `gmail-login.ts` 中增加对 `recoveryEmail` 字段的接收，并适配 Google 的“选择验证方式界面”与“确认辅助邮箱挑战界面”。
3. 在 `bulk-2fa.processor.ts` 中传入 `recoveryEmail`，并启用 `manualChallengeWaitMs` 限制以允许人工干预。

**Tech Stack:** NestJS, Playwright, Vitest

---

### Task 1: 完善解析服务 `bulk-2fa.service.ts` 及单元测试

**Files:**
- Create: `apps/api/src/bulk-2fa/bulk-2fa.service.spec.ts`
- Modify: `apps/api/src/bulk-2fa/bulk-2fa.service.ts`

- [ ] **Step 1: 编写失败的解析单元测试**
  在 `apps/api/src/bulk-2fa/bulk-2fa.service.spec.ts` 写入测试用例，覆盖智能检测格式和多行合并解析逻辑。
  ```typescript
  import { Test, TestingModule } from "@nestjs/testing";
  import { Bulk2faService } from "./bulk-2fa.service";
  import { Queue } from "bullmq";

  describe("Bulk2faService - createJob parsing", () => {
    let service: Bulk2faService;
    const mockQueue = { add: () => Promise.resolve() };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          Bulk2faService,
          {
            provide: "BullQueue_bulk-2fa-queue",
            useValue: mockQueue,
          },
        ],
      }).compile();

      service = module.get<Bulk2faService>(Bulk2faService);
    });

    it("should correctly parse and classify columns when recovery email and TOTP secret are reversed", async () => {
      // 输入数据：辅助邮箱在第3列，2fa.live 链接在第4列
      const text = "ParaaMarie647@gmail.com----ycbzttayda----ParaaMarie64718143@westt.site----https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th";
      const job = await service.createJob(text);
      expect(job.items).toHaveLength(1);
      expect(job.items[0].email).toBe("ParaaMarie647@gmail.com");
      expect(job.items[0].password).toBe("ycbzttayda");
      expect(job.items[0].recoveryEmail).toBe("ParaaMarie64718143@westt.site");
      expect(job.items[0].oldSecret).toBe("UEKAMA7ND3EKDHIQ4FOHUGDBGW3YM6TH");
    });

    it("should support multi-line continuation records", async () => {
      // 输入数据分行录入，其中第二行和第三行为延续字段
      const text = [
        "ParaaMarie647@gmail.com----ycbzttayda----",
        "ParaaMarie64718143@westt.site----",
        "https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th"
      ].join("\n");
      const job = await service.createJob(text);
      expect(job.items).toHaveLength(1);
      expect(job.items[0].email).toBe("ParaaMarie647@gmail.com");
      expect(job.items[0].password).toBe("ycbzttayda");
      expect(job.items[0].recoveryEmail).toBe("ParaaMarie64718143@westt.site");
      expect(job.items[0].oldSecret).toBe("UEKAMA7ND3EKDHIQ4FOHUGDBGW3YM6TH");
    });
  });
  ```

- [ ] **Step 2: 运行测试确保失败**
  运行：`pnpm --filter @gfa/api test` 
  期待：单元测试失败，显示无法正确解析或归类字段。

- [ ] **Step 3: 编写最小实现代码**
  修改 `apps/api/src/bulk-2fa/bulk-2fa.service.ts` 中的 `createJob` 及其辅助函数。
  ```typescript
  // 替换 apps/api/src/bulk-2fa/bulk-2fa.service.ts 中的 createJob 逻辑，并加入 extractTotp 与 classifyField 方法
  ```
  在 `Bulk2faService` 类中新增以下私有方法：
  ```typescript
  private extractTotp(raw: string): string {
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/2fa\.live\/tok\/([a-z0-9]+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    return trimmed.replace(/[\s\-=]/g, "").toUpperCase();
  }

  private classifyField(value: string): "email" | "totp" {
    const trimmed = value.trim();
    if (trimmed.includes("@")) return "email";
    return "totp";
  }
  ```
  更新 `createJob` 方法：
  ```typescript
  async createJob(text: string): Promise<BulkJob> {
    const jobId = `job_${Date.now()}`;
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    
    interface ParsedItem {
      email: string;
      password: string;
      oldSecret?: string;
      recoveryEmail?: string;
      rawLines: string[];
    }
    const parsedItems: ParsedItem[] = [];
    let currentItem: ParsedItem | null = null;

    for (const line of rawLines) {
      const parts = line.split(/-{3,}|,|\||\t/).map(p => p.trim());
      const firstPart = parts[0] || "";
      const secondPart = parts[1] || "";
      
      const isNewAccount = firstPart.includes("@") && secondPart !== "";

      if (isNewAccount) {
        currentItem = {
          email: firstPart,
          password: secondPart,
          rawLines: [line]
        };
        parsedItems.push(currentItem);
        
        const extra = parts.slice(2).filter(Boolean);
        for (const field of extra) {
          const kind = this.classifyField(field);
          if (kind === "email" && !currentItem.recoveryEmail) {
            currentItem.recoveryEmail = field;
          } else if (kind === "totp" && !currentItem.oldSecret) {
            currentItem.oldSecret = this.extractTotp(field);
          }
        }
      } else if (currentItem) {
        currentItem.rawLines.push(line);
        const extra = parts.filter(Boolean);
        for (const field of extra) {
          const kind = this.classifyField(field);
          if (kind === "email" && !currentItem.recoveryEmail) {
            currentItem.recoveryEmail = field;
          } else if (kind === "totp" && !currentItem.oldSecret) {
            currentItem.oldSecret = this.extractTotp(field);
          }
        }
      }
    }

    const items: BulkJobItem[] = parsedItems.map((pi, idx) => {
      return {
        id: `item_${idx + 1}`,
        rawLine: pi.rawLines.join("----"),
        email: pi.email,
        password: pi.password,
        oldSecret: pi.oldSecret,
        recoveryEmail: pi.recoveryEmail,
        status: "PENDING",
        updatedAt: new Date().toISOString()
      };
    });

    const job: BulkJob = {
      id: jobId,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items
    };

    fs.writeFileSync(this.getJobPath(jobId), JSON.stringify(job, null, 2), "utf8");
    
    await this.queue.add("process-bulk", { jobId }, {
      attempts: 1,
      jobId: `bulk-2fa-${jobId}`
    });

    return job;
  }
  ```

- [ ] **Step 4: 运行测试确保通过**
  运行：`pnpm --filter @gfa/api test`
  期待：PASS

- [ ] **Step 5: 提交代码**
  ```bash
  git add apps/api/src/bulk-2fa/
  git commit -m "feat(api): improve bulk-2fa parsing logic to dynamically classify recoveryEmail and oldSecret"
  ```

---

### Task 2: 登录流程 `gmail-login.ts` 的自动辅助邮箱验证与单元测试

**Files:**
- Modify: `apps/worker/src/gmail-login.ts`
- Modify: `apps/worker/src/__tests__/gmail-login.unit.spec.ts`

- [ ] **Step 1: 在 `gmail-login.ts` 的类型定义中引入 `recoveryEmail` 属性**
  修改 `apps/worker/src/gmail-login.ts` 的 `LoginCredentials` 接口：
  ```typescript
  // apps/worker/src/gmail-login.ts:L127-131
  export interface LoginCredentials {
    loginEmail: string;
    loginPassword: string | null;
    totpSecret?: string | null;
    recoveryEmail?: string | null; // 新增
  }
  ```

- [ ] **Step 2: 编写辅助邮箱挑战的失败单元测试**
  在 `apps/worker/src/__tests__/gmail-login.unit.spec.ts` 中新增关于辅助邮箱验证页面以及选项的测试用例：
  ```typescript
  describe("gmailLogin — recovery email challenge", () => {
    it("autofills recovery email when recovery email input page is detected", async () => {
      const recoveryFill = vi.fn().mockResolvedValue(undefined);
      const page = buildMockPage({
        urlSequence: [
          "https://accounts.google.com",
          "https://accounts.google.com",
          "https://accounts.google.com",
          "https://accounts.google.com/challenge/pwd",
          "https://accounts.google.com/challenge/pwd",
          "https://accounts.google.com/challenge/ipe", // 模拟辅助邮箱确认页
        ],
        locatorOverrides: {
          "email": buildLocator({ count: 1 }),
          "password": buildLocator({ count: 1 }),
          "knowledgePrereqValue": buildLocator({ count: 1, fill: recoveryFill }),
        },
      });

      const result = await gmailLogin(
        page,
        { loginEmail: "u@gmail.com", loginPassword: "pw", recoveryEmail: "recovery@gmail.com" },
        buildMockLogger()
      );

      // 虽然最终没成功进 myaccount（因为只模拟到 ipe 页），但要确认调用了 fill
      expect(recoveryFill).toHaveBeenCalledWith("recovery@gmail.com");
    });
  });
  ```

- [ ] **Step 3: 运行测试确保失败**
  运行：`pnpm --filter @gfa/worker test:unit`
  期待：单元测试失败。

- [ ] **Step 4: 实现自动选择与自动填充辅助邮箱代码**
  修改 `apps/worker/src/gmail-login.ts`：
  1. 在 `handleChallengeSelection`（约1140行）中，如果 `totpSecret` 未匹配成功，且 `credentials.recoveryEmail` 存在，查找并点击辅助邮箱选项：
  ```typescript
    // Priority 2: Recovery Email (if recoveryEmail is set)
    if (credentials.recoveryEmail) {
      const recoveryOption = page.locator([
        'li:has-text("Confirm your recovery email")',
        'li:has-text("辅助邮箱")',
        'li:has-text("備用電子郵件")',
        'div[role="link"]:has-text("Confirm your recovery email")',
        'div[role="link"]:has-text("辅助邮箱")',
        'div[role="link"]:has-text("備用電子郵件")',
        'a:has-text("Confirm your recovery email")',
        'a:has-text("辅助邮箱")',
      ].join(", "));
      const recoveryCount = await recoveryOption.count();
      if (recoveryCount > 0) {
        await recoveryOption.first().click();
        await logger.log("INFO", "[gmail-login] ✅ Selected Recovery Email option from challenge selection");
        return true;
      }
    }
  ```
  2. 在 `gmailLogin` 的 Round 循环（约 420 行附近）中检测并处理确认辅助邮箱页面：
  ```typescript
      // 辅助邮箱确认页面检测
      const recoveryEmailInput = page.locator(
        'input[name="knowledgePrereqValue"], input[id="knowledgePrereqValue"]'
      );
      if (await recoveryEmailInput.count() > 0 && await recoveryEmailInput.first().isVisible()) {
        await logger.log("INFO", "[gmail-login] Recovery email challenge detected");
        if (!credentials.recoveryEmail) {
          return {
            success: false,
            reason: "VERIFICATION_REQUIRED",
            detail: "Recovery email verification required but recoveryEmail is not configured",
          };
        }
        await recoveryEmailInput.first().fill(credentials.recoveryEmail);
        await clickNext(page, logger);
        await waitForNextState(page, 5000);
        continue;
      }
  ```

- [ ] **Step 5: 运行测试确保通过**
  运行：`pnpm --filter @gfa/worker test:unit`
  期待：PASS

- [ ] **Step 6: 提交代码**
  ```bash
  git add apps/worker/src/gmail-login.ts apps/worker/src/__tests__/gmail-login.unit.spec.ts
  git commit -m "feat(worker): add recovery email confirmation challenge support during gmail login"
  ```

---

### Task 3: 处理器 `bulk-2fa.processor.ts` 的参数集成

**Files:**
- Modify: `apps/worker/src/processors/bulk-2fa.processor.ts`

- [ ] **Step 1: 传入 `recoveryEmail` 和 `manualChallengeWaitMs` 参数**
  修改 `apps/worker/src/processors/bulk-2fa.processor.ts` 的 `processBulk2FA`：
  ```typescript
  // apps/worker/src/processors/bulk-2fa.processor.ts:95-99
      const loginResult = await gmailLogin(page, {
        loginEmail: item.email,
        loginPassword: item.password,
        totpSecret: item.oldSecret || null,
        recoveryEmail: item.recoveryEmail || null // 传递辅助邮箱
      }, itemLogger, {
        manualChallengeWaitMs: 300000 // 允许 5 分钟人工干预时间以防遇到滑块/手机验证码
      });
  ```

- [ ] **Step 2: 运行 worker 编译**
  运行：`pnpm --filter @gfa/worker build`
  期待：构建成功无 TS 编译错误。

- [ ] **Step 3: 提交代码**
  ```bash
  git add apps/worker/src/processors/bulk-2fa.processor.ts
  git commit -m "feat(worker): enable manual challenge wait and pass recoveryEmail in bulk 2fa worker"
  ```
