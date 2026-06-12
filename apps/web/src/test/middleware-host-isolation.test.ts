/**
 * Middleware host-isolation tests (ADMIN_HOST).
 *
 * The middleware reads its env configuration (ADMIN_HOST, ADMIN_PATH_PREFIX,
 * ADMIN_IP_ALLOWLIST) at module scope, so every scenario stubs the env and
 * re-imports the module via vi.resetModules().
 *
 * Response conventions asserted here:
 *   - pass-through:  NextResponse.next()      → header x-middleware-next: 1
 *   - redirect:      NextResponse.redirect()  → status 307 + location header
 *   - rewrite:       NextResponse.rewrite()   → header x-middleware-rewrite
 *   - blocked:       404 with empty body
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { CONSOLE_AUTH_COOKIE } from "@/lib/console/auth-cookie";
import { USER_AUTH_COOKIE } from "@/lib/account/user-auth-cookie";

type MiddlewareFn = (request: NextRequest) => Response;

async function loadMiddleware(env: {
  ADMIN_HOST?: string;
  ADMIN_PATH_PREFIX?: string;
  ADMIN_IP_ALLOWLIST?: string;
}): Promise<MiddlewareFn> {
  vi.resetModules();
  // next.config.ts always injects a normalized ADMIN_PATH_PREFIX at build
  // time (default "console"), so mirror that default here.
  vi.stubEnv("ADMIN_PATH_PREFIX", env.ADMIN_PATH_PREFIX ?? "console");
  vi.stubEnv("ADMIN_HOST", env.ADMIN_HOST);
  vi.stubEnv("ADMIN_IP_ALLOWLIST", env.ADMIN_IP_ALLOWLIST);
  const mod = await import("@/middleware");
  return mod.middleware as MiddlewareFn;
}

function makeRequest(
  url: string,
  options: { cookies?: Record<string, string>; ip?: string } = {}
): NextRequest {
  const headers = new Headers();
  // NextRequest derives nextUrl from the URL; getRequestHost() falls back to
  // nextUrl.host when no Host header survives Request construction. Try to
  // set it explicitly too, mirroring what the reverse proxy forwards.
  try {
    headers.set("host", new URL(url).host);
  } catch {
    /* ignore — fallback path covers it */
  }
  if (options.ip) {
    headers.set("x-forwarded-for", options.ip);
  }
  if (options.cookies) {
    headers.set(
      "cookie",
      Object.entries(options.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ")
    );
  }
  return new NextRequest(url, { headers });
}

function expectPassThrough(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
}

function expectRedirectTo(response: Response, pathname: string) {
  expect(response.status).toBe(307);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  expect(new URL(location as string).pathname).toBe(pathname);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Baseline: ADMIN_HOST unset → single-domain behavior unchanged ───────────

describe("ADMIN_HOST unset (single-domain baseline)", () => {
  it("serves marketing pages on any host", async () => {
    const middleware = await loadMiddleware({});
    expectPassThrough(middleware(makeRequest("https://example.com/")));
    expectPassThrough(middleware(makeRequest("https://example.com/about")));
    expectPassThrough(middleware(makeRequest("https://whatever.test/download")));
  });

  it("redirects unauthenticated /console to /console/login", async () => {
    const middleware = await loadMiddleware({});
    const response = middleware(makeRequest("https://example.com/console"));
    expectRedirectTo(response, "/console/login");
  });

  it("passes authenticated /console through", async () => {
    const middleware = await loadMiddleware({});
    const response = middleware(
      makeRequest("https://example.com/console", {
        cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
      })
    );
    expectPassThrough(response);
  });

  it("keeps the /account portal branch intact", async () => {
    const middleware = await loadMiddleware({});
    expectRedirectTo(
      middleware(makeRequest("https://example.com/account/billing")),
      "/account/login"
    );
    expectPassThrough(middleware(makeRequest("https://example.com/account/login")));
    expectPassThrough(
      middleware(
        makeRequest("https://example.com/account", {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
  });

  it("serves the root /login console page and session API publicly", async () => {
    const middleware = await loadMiddleware({});
    expectPassThrough(middleware(makeRequest("https://example.com/login")));
    expectPassThrough(middleware(makeRequest("https://example.com/api/console-session/login")));
  });

  it("passes customer and console APIs through", async () => {
    const middleware = await loadMiddleware({});
    expectPassThrough(middleware(makeRequest("https://example.com/api/account/portal")));
    expectPassThrough(middleware(makeRequest("https://example.com/api/console/orders")));
    expectPassThrough(middleware(makeRequest("https://example.com/api/app/heartbeat")));
  });

  it("custom ADMIN_PATH_PREFIX still hides /console and rewrites the alias", async () => {
    const middleware = await loadMiddleware({ ADMIN_PATH_PREFIX: "manage-x7k2p" });
    expectNotFound(middleware(makeRequest("https://example.com/console")));
    const rewritten = middleware(makeRequest("https://example.com/manage-x7k2p/login"));
    const rewriteTarget = rewritten.headers.get("x-middleware-rewrite");
    expect(rewriteTarget).toBeTruthy();
    expect(new URL(rewriteTarget as string).pathname).toBe("/console/login");
  });
});

// ─── Admin host: only the console surface exists ──────────────────────────────

describe("ADMIN_HOST set — requests on the admin host", () => {
  const env = { ADMIN_HOST: "admin.example.com" };
  const adminUrl = (path: string) => `https://admin.example.com${path}`;

  it("serves the console (login page public, dashboard cookie-gated)", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(adminUrl("/console/login"))));
    expectRedirectTo(middleware(makeRequest(adminUrl("/console"))), "/console/login");
    expectPassThrough(
      middleware(
        makeRequest(adminUrl("/console/orders"), {
          cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectPassThrough(middleware(makeRequest(adminUrl("/login"))));
  });

  it("redirects the bare admin domain root to /console (default prefix)", async () => {
    const middleware = await loadMiddleware(env);
    expectRedirectTo(middleware(makeRequest(adminUrl("/"))), "/console");
  });

  it("404s marketing pages and /account — even with a user cookie", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest(adminUrl("/about"))));
    expectNotFound(middleware(makeRequest(adminUrl("/download"))));
    expectNotFound(
      middleware(
        makeRequest(adminUrl("/account"), {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(adminUrl("/account/billing"))));
  });

  it("404s customer API namespaces", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest(adminUrl("/api/account/portal"))));
    expectNotFound(middleware(makeRequest(adminUrl("/api/account-session/login"))));
    expectNotFound(middleware(makeRequest(adminUrl("/api/app/heartbeat"))));
    expectNotFound(middleware(makeRequest(adminUrl("/api/epay/notify"))));
  });

  it("passes the console session API and admin backend APIs", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(adminUrl("/api/console-session/login"))));
    expectPassThrough(middleware(makeRequest(adminUrl("/api/console/accounts"))));
    expectPassThrough(middleware(makeRequest(adminUrl("/api/console/orders"))));
    expectPassThrough(middleware(makeRequest(adminUrl("/api/console/rosetta/keys"))));
  });

  it("passes the lease-pool ops under /api/app/lease (console pages use them)", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(
      middleware(makeRequest(adminUrl("/api/app/lease/antigravity/status")))
    );
    expectPassThrough(
      middleware(makeRequest(adminUrl("/api/app/lease/antigravity/announcement")))
    );
    expectPassThrough(
      middleware(makeRequest(adminUrl("/api/app/lease/codex/reload-access-keys")))
    );
    // …while the rest of the desktop-client surface stays customer-only.
    expectNotFound(middleware(makeRequest(adminUrl("/api/app/heartbeat"))));
  });

  it("ignores a :port suffix when matching the admin host", async () => {
    const middleware = await loadMiddleware(env);
    const response = middleware(
      makeRequest("http://admin.example.com:3000/console/login")
    );
    expectPassThrough(response);
  });

  it("applies the IP allowlist to the whole host", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ADMIN_IP_ALLOWLIST: "10.1.2.3",
    });
    // Blocked IP: every admin-host path 404s, including login + backend APIs.
    expectNotFound(middleware(makeRequest(adminUrl("/console/login"), { ip: "9.9.9.9" })));
    expectNotFound(middleware(makeRequest(adminUrl("/api/console/accounts"), { ip: "9.9.9.9" })));
    expectNotFound(middleware(makeRequest(adminUrl("/login"), { ip: "9.9.9.9" })));
    // Allowed IP: normal behavior.
    expectPassThrough(
      middleware(makeRequest(adminUrl("/console/login"), { ip: "10.1.2.3" }))
    );
    expectPassThrough(
      middleware(makeRequest(adminUrl("/api/console/accounts"), { ip: "10.1.2.3" }))
    );
  });

  it("does not leak a custom ADMIN_PATH_PREFIX via the root redirect", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ADMIN_PATH_PREFIX: "manage-x7k2p",
    });
    expectNotFound(middleware(makeRequest(adminUrl("/"))));
    // The alias still rewrites to /console internally…
    const rewritten = middleware(makeRequest(adminUrl("/manage-x7k2p/login")));
    const rewriteTarget = rewritten.headers.get("x-middleware-rewrite");
    expect(rewriteTarget).toBeTruthy();
    expect(new URL(rewriteTarget as string).pathname).toBe("/console/login");
    // …while direct /console access stays hidden (pre-existing rule).
    expectNotFound(middleware(makeRequest(adminUrl("/console"))));
  });
});

// ─── Customer host: the console surface does not exist ────────────────────────

describe("ADMIN_HOST set — requests on the customer host", () => {
  const env = { ADMIN_HOST: "admin.example.com" };
  const mainUrl = (path: string) => `https://example.com${path}`;

  it("404s the console surface — even with a console cookie", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest(mainUrl("/console"))));
    expectNotFound(middleware(makeRequest(mainUrl("/console/login"))));
    expectNotFound(
      middleware(
        makeRequest(mainUrl("/console/orders"), {
          cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(mainUrl("/login"))));
    expectNotFound(middleware(makeRequest(mainUrl("/api/console-session/login"))));
    expectNotFound(middleware(makeRequest(mainUrl("/api/console/orders"))));
  });

  it("404s a custom ADMIN_PATH_PREFIX alias too", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ADMIN_PATH_PREFIX: "manage-x7k2p",
    });
    expectNotFound(middleware(makeRequest(mainUrl("/manage-x7k2p"))));
    expectNotFound(middleware(makeRequest(mainUrl("/manage-x7k2p/login"))));
  });

  it("keeps marketing, /account and customer APIs working", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(mainUrl("/"))));
    expectPassThrough(middleware(makeRequest(mainUrl("/about"))));
    expectRedirectTo(
      middleware(makeRequest(mainUrl("/account/billing"))),
      "/account/login"
    );
    expectPassThrough(
      middleware(
        makeRequest(mainUrl("/account"), {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectPassThrough(middleware(makeRequest(mainUrl("/api/account/portal"))));
    expectPassThrough(middleware(makeRequest(mainUrl("/api/account-session/login"))));
    expectPassThrough(middleware(makeRequest(mainUrl("/api/app/heartbeat"))));
  });

  it("treats unknown hosts (fallback domains, raw IPs) as customer hosts", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest("https://fallback.test/console")));
    expectPassThrough(middleware(makeRequest("https://fallback.test/about")));
    expectNotFound(middleware(makeRequest("http://203.0.113.7/console")));
  });
});
