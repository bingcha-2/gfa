import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerUserMock, routerMock, refParam } = vi.hoisted(() => ({
  registerUserMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    refresh: vi.fn(),
  },
  refParam: { value: null as string | null },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({
    get: (key: string) => (key === "ref" ? refParam.value : null),
  }),
}));

vi.mock("@/lib/account/user-api", () => ({
  registerUser: registerUserMock,
}));

import { RegisterForm } from "@/components/account/auth/register-form";

function fillCredentials(container: HTMLElement) {
  fireEvent.change(container.querySelector("input[type='email']")!, {
    target: { value: "member@example.com" },
  });
  fireEvent.change(container.querySelector("input[type='password']")!, {
    target: { value: "secret123" },
  });
}

describe("RegisterForm referral code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerUserMock.mockResolvedValue({ ok: true });
    refParam.value = null;
  });

  it("pre-fills the invite code from ?ref= and submits it (normalized to upper-case)", async () => {
    refParam.value = "abcd1234";
    const { container } = render(<RegisterForm />);

    const refInput = container.querySelector<HTMLInputElement>(
      "input[name='referralCode']"
    )!;
    expect(refInput.value).toBe("ABCD1234");

    fillCredentials(container);
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(registerUserMock).toHaveBeenCalledWith(
        "member@example.com",
        "secret123",
        undefined,
        "ABCD1234"
      );
    });
  });

  it("lets the user override the pre-filled code", async () => {
    refParam.value = "FROMLINK";
    const { container } = render(<RegisterForm />);

    const refInput = container.querySelector<HTMLInputElement>(
      "input[name='referralCode']"
    )!;
    fireEvent.change(refInput, { target: { value: "typed9" } });

    fillCredentials(container);
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(registerUserMock).toHaveBeenCalledWith(
        "member@example.com",
        "secret123",
        undefined,
        "TYPED9"
      );
    });
  });

  it("sends no referral code when the field is empty", async () => {
    const { container } = render(<RegisterForm />);
    fillCredentials(container);
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(registerUserMock).toHaveBeenCalledWith(
        "member@example.com",
        "secret123",
        undefined,
        undefined
      );
    });
  });
});
