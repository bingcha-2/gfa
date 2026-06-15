/**
 * Tests for account auth card brand context:
 *   src/components/account/auth/auth-card.tsx
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AuthCard } from "@/components/account/auth/auth-card";

describe("AuthCard", () => {
  it("shows BingchaAI brand context and account recovery paths", () => {
    render(
      <AuthCard title="登录冰茶AI" description="用你的账号登录用户门户">
        <button type="button">登录</button>
      </AuthCard>
    );

    // New editorial membership auth shell + signature pass card.
    expect(document.querySelector(".account-auth")).toBeInTheDocument();
    expect(document.querySelector(".account-auth-card")).toBeInTheDocument();
    expect(document.querySelector(".account-auth-card__brand")).toBeInTheDocument();
    expect(document.querySelector(".account-pass")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换账户界面深浅模式" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "登录冰茶AI" })).toBeInTheDocument();
    expect(screen.getByText("用你的账号登录用户门户")).toBeInTheDocument();
    expect(screen.getByText("本地只注入 Token")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载客户端" })).toHaveAttribute(
      "href",
      "/download"
    );
    expect(screen.getByRole("link", { name: "返回官网" })).toHaveAttribute("href", "/");
    // bcai.store 卡密购买入口已移除,不应再出现。
    expect(screen.queryByRole("link", { name: "购买卡密" })).not.toBeInTheDocument();
  });
});
