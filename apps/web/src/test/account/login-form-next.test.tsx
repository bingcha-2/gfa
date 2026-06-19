import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loginUserMock, routerMock, nextParam } = vi.hoisted(() => ({
  loginUserMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    refresh: vi.fn(),
  },
  nextParam: { value: "/account/support" as string | null },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({
    get: (key: string) => (key === "next" ? nextParam.value : null),
  }),
}));

vi.mock("@/lib/account/user-api", () => ({
  loginUser: loginUserMock,
}));

import { LoginForm } from "@/components/account/auth/login-form";

describe("LoginForm next redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginUserMock.mockResolvedValue({ ok: true });
    nextParam.value = "/account/support";
  });

  it("returns to a safe account next path after login", async () => {
    const { container } = render(<LoginForm />);

    fireEvent.change(container.querySelector("input[type='email']")!, {
      target: { value: "member@example.com" },
    });
    fireEvent.change(container.querySelector("input[type='password']")!, {
      target: { value: "secret" },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/account/support");
    });
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it("falls back to account home for unsafe next values", async () => {
    nextParam.value = "https://evil.example/account/support";
    const { container } = render(<LoginForm />);

    fireEvent.change(container.querySelector("input[type='email']")!, {
      target: { value: "member@example.com" },
    });
    fireEvent.change(container.querySelector("input[type='password']")!, {
      target: { value: "secret" },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/account");
    });
  });
});
