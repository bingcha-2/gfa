/**
 * Middleware host-isolation tests (MARKETING_HOST / ACCOUNT_HOST /
 * CONSOLE_HOST, with ADMIN_HOST as the legacy alias for CONSOLE_HOST).
 *
 * The middleware reads its env configuration (host envs, ADMIN_PATH_PREFIX,
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
  MARKETING_HOST?: string;
  ACCOUNT_HOST?: string;
  CONSOLE_HOST?: string;
  ADMIN_HOST?: string;
  ADMIN_PATH_PREFIX?: string;
  ADMIN_IP_ALLOWLIST?: string;
}): Promise<MiddlewareFn> {
  vi.resetModules();
  // next.config.ts always injects a normalized ADMIN_PATH_PREFIX at build
  // time (default "console"), so mirror that default here.
  vi.stubEnv("ADMIN_PATH_PREFIX", env.ADMIN_PATH_PREFIX ?? "console");
  vi.stubEnv("MARKETING_HOST", env.MARKETING_HOST);
  vi.stubEnv("ACCOUNT_HOST", env.ACCOUNT_HOST);
  vi.stubEnv("CONSOLE_HOST", env.CONSOLE_HOST);
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

// ─── Baseline: all host envs unset → single-domain behavior unchanged ────────

describe("all host envs unset (single-domain baseline)", () => {
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

// ─── Console host (via the legacy ADMIN_HOST alias): only the console surface ─

describe("ADMIN_HOST set (legacy alias) — requests on the admin host", () => {
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

  it("serves the shared app icon (root layout references it on every surface)", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(adminUrl("/bcai-icon.png"))));
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

// ─── Unmatched host while only the console host is configured: the legacy ─────
// ─── combined customer surface (marketing + /account), console 404'd ──────────

describe("ADMIN_HOST set — requests on an unmatched (customer) host", () => {
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

// ─── CONSOLE_HOST: the canonical env name (and its precedence over the alias) ─

describe("CONSOLE_HOST set (canonical env)", () => {
  it("behaves exactly like ADMIN_HOST", async () => {
    const middleware = await loadMiddleware({ CONSOLE_HOST: "console.example.com" });
    const consoleUrl = (path: string) => `https://console.example.com${path}`;
    expectPassThrough(middleware(makeRequest(consoleUrl("/console/login"))));
    expectRedirectTo(middleware(makeRequest(consoleUrl("/"))), "/console");
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/console/orders"))));
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/app/lease/codex/status"))));
    expectNotFound(middleware(makeRequest(consoleUrl("/account/billing"))));
    expectNotFound(middleware(makeRequest(consoleUrl("/api/app/heartbeat"))));
    // …and the console surface is gone from every other host.
    expectNotFound(middleware(makeRequest("https://example.com/console")));
    expectPassThrough(middleware(makeRequest("https://example.com/about")));
  });

  it("wins over a simultaneously set ADMIN_HOST alias", async () => {
    const middleware = await loadMiddleware({
      CONSOLE_HOST: "console.example.com",
      ADMIN_HOST: "admin.example.com",
    });
    expectPassThrough(
      middleware(makeRequest("https://console.example.com/console/login"))
    );
    // The alias hostname is just another customer host now.
    expectNotFound(middleware(makeRequest("https://admin.example.com/console/login")));
    expectPassThrough(middleware(makeRequest("https://admin.example.com/about")));
  });
});

// ─── Full split: MARKETING_HOST + ACCOUNT_HOST + CONSOLE_HOST ─────────────────

describe("full split (all three host envs set)", () => {
  const env = {
    MARKETING_HOST: "example.com",
    ACCOUNT_HOST: "my.example.com",
    CONSOLE_HOST: "console.example.com",
  };
  const marketingUrl = (path: string) => `https://example.com${path}`;
  const accountUrl = (path: string) => `https://my.example.com${path}`;
  const consoleUrl = (path: string) => `https://console.example.com${path}`;

  // ── Marketing host ──────────────────────────────────────────────────────────
  it("marketing host serves marketing pages and static assets", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(marketingUrl("/"))));
    expectPassThrough(middleware(makeRequest(marketingUrl("/about"))));
    expectPassThrough(middleware(makeRequest(marketingUrl("/download"))));
    expectPassThrough(middleware(makeRequest(marketingUrl("/bcai-icon.png"))));
    expectPassThrough(middleware(makeRequest(marketingUrl("/logos/wordmark.svg"))));
  });

  it("marketing host serves /api/faq-images (FAQ content embeds them) but no other API", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(marketingUrl("/api/faq-images/x.png"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/account/portal"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/account-session/login"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/console/orders"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/console-session/login"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/app/heartbeat"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/epay/notify"))));
    expectNotFound(middleware(makeRequest(marketingUrl("/api/health"))));
  });

  it("marketing host 404s the account and console surfaces — even with cookies", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(
      middleware(
        makeRequest(marketingUrl("/account/billing"), {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(marketingUrl("/account"))));
    expectNotFound(
      middleware(
        makeRequest(marketingUrl("/console"), {
          cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(marketingUrl("/login"))));
  });

  // ── Account host ────────────────────────────────────────────────────────────
  it("account host serves the portal (auth pages public, rest cookie-gated)", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(accountUrl("/account/login"))));
    expectRedirectTo(
      middleware(makeRequest(accountUrl("/account/billing"))),
      "/account/login"
    );
    expectPassThrough(
      middleware(
        makeRequest(accountUrl("/account/billing"), {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectPassThrough(middleware(makeRequest(accountUrl("/api/account/portal"))));
    expectPassThrough(middleware(makeRequest(accountUrl("/api/account-session/login"))));
    expectPassThrough(middleware(makeRequest(accountUrl("/bcai-icon.png"))));
  });

  it("account host redirects the bare root to /account", async () => {
    const middleware = await loadMiddleware(env);
    expectRedirectTo(middleware(makeRequest(accountUrl("/"))), "/account");
  });

  it("account host 404s marketing pages, the console surface and machine APIs", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest(accountUrl("/about"))));
    expectNotFound(middleware(makeRequest(accountUrl("/download"))));
    expectNotFound(
      middleware(
        makeRequest(accountUrl("/console"), {
          cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(accountUrl("/login"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/console/orders"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/console-session/login"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/app/heartbeat"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/app/lease/codex/status"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/epay/notify"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/remote-stats"))));
    expectNotFound(middleware(makeRequest(accountUrl("/api/faq-images/x.png"))));
  });

  it("account host does not let /api/account leak the console namespace (exact-segment match)", async () => {
    const middleware = await loadMiddleware(env);
    // sibling-prefix probe: /api/account-evil is neither /api/account nor
    // /api/account-session.
    expectNotFound(middleware(makeRequest(accountUrl("/api/account-evil/x"))));
  });

  // ── Console host ────────────────────────────────────────────────────────────
  it("console host serves the console surface and its ops APIs", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest(consoleUrl("/console/login"))));
    expectRedirectTo(middleware(makeRequest(consoleUrl("/console"))), "/console/login");
    expectPassThrough(
      middleware(
        makeRequest(consoleUrl("/console/orders"), {
          cookies: { [CONSOLE_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectPassThrough(middleware(makeRequest(consoleUrl("/login"))));
    expectRedirectTo(middleware(makeRequest(consoleUrl("/"))), "/console");
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/console-session/login"))));
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/console/orders"))));
    // Console-consumed ops APIs outside /api/console:
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/app/lease/codex/status"))));
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/remote-stats/dashboard"))));
    expectPassThrough(middleware(makeRequest(consoleUrl("/api/faq-images/x.png"))));
    expectPassThrough(middleware(makeRequest(consoleUrl("/bcai-icon.png"))));
  });

  it("console host 404s the customer and marketing surfaces", async () => {
    const middleware = await loadMiddleware(env);
    expectNotFound(middleware(makeRequest(consoleUrl("/about"))));
    expectNotFound(
      middleware(
        makeRequest(consoleUrl("/account/billing"), {
          cookies: { [USER_AUTH_COOKIE]: "token" },
        })
      )
    );
    expectNotFound(middleware(makeRequest(consoleUrl("/api/account/portal"))));
    expectNotFound(middleware(makeRequest(consoleUrl("/api/account-session/login"))));
    expectNotFound(middleware(makeRequest(consoleUrl("/api/app/heartbeat"))));
    expectNotFound(middleware(makeRequest(consoleUrl("/api/epay/notify"))));
  });

  // ── Unmatched host ──────────────────────────────────────────────────────────
  it("unmatched hosts (raw IP, localhost) keep the legacy customer surface, console denied", async () => {
    const middleware = await loadMiddleware(env);
    expectPassThrough(middleware(makeRequest("http://localhost:3000/about")));
    expectRedirectTo(
      middleware(makeRequest("http://localhost:3000/account/billing")),
      "/account/login"
    );
    expectPassThrough(middleware(makeRequest("http://localhost:3000/api/account/portal")));
    expectNotFound(middleware(makeRequest("http://localhost:3000/console")));
    expectNotFound(middleware(makeRequest("http://203.0.113.7/api/console/orders")));
    expectNotFound(middleware(makeRequest("http://203.0.113.7/login")));
  });

  // ── Cross-host hygiene ──────────────────────────────────────────────────────
  it("matches hosts case-insensitively and ignores :port suffixes", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ACCOUNT_HOST: "MY.Example.com:443",
    });
    expectRedirectTo(
      middleware(makeRequest("http://my.example.com:3000/")),
      "/account"
    );
    expectNotFound(middleware(makeRequest("https://my.example.com/about")));
  });

  it("applies the IP allowlist only to the console host", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ADMIN_IP_ALLOWLIST: "10.1.2.3",
    });
    expectNotFound(
      middleware(makeRequest(consoleUrl("/console/login"), { ip: "9.9.9.9" }))
    );
    expectPassThrough(
      middleware(makeRequest(consoleUrl("/console/login"), { ip: "10.1.2.3" }))
    );
    // Customer surfaces are not IP-fenced.
    expectPassThrough(middleware(makeRequest(accountUrl("/account/login"), { ip: "9.9.9.9" })));
    expectPassThrough(middleware(makeRequest(marketingUrl("/about"), { ip: "9.9.9.9" })));
  });

  it("hides a custom ADMIN_PATH_PREFIX on every non-console host", async () => {
    const middleware = await loadMiddleware({
      ...env,
      ADMIN_PATH_PREFIX: "manage-x7k2p",
    });
    expectNotFound(middleware(makeRequest(marketingUrl("/manage-x7k2p/login"))));
    expectNotFound(middleware(makeRequest(accountUrl("/manage-x7k2p/login"))));
    // …while the console host still rewrites the alias internally.
    const rewritten = middleware(makeRequest(consoleUrl("/manage-x7k2p/login")));
    const rewriteTarget = rewritten.headers.get("x-middleware-rewrite");
    expect(rewriteTarget).toBeTruthy();
    expect(new URL(rewriteTarget as string).pathname).toBe("/console/login");
  });
});

// ─── Partial config: the gate activates with ANY host env; console fails closed ─

describe("partial host config", () => {
  it("ACCOUNT_HOST alone isolates the portal; other hosts keep marketing but lose the console", async () => {
    const middleware = await loadMiddleware({ ACCOUNT_HOST: "my.example.com" });
    // Account host: portal only.
    expectRedirectTo(middleware(makeRequest("https://my.example.com/")), "/account");
    expectPassThrough(middleware(makeRequest("https://my.example.com/account/login")));
    expectNotFound(middleware(makeRequest("https://my.example.com/about")));
    // Unmatched host: marketing + account still served (legacy surface)…
    expectPassThrough(middleware(makeRequest("https://example.com/about")));
    expectPassThrough(middleware(makeRequest("https://example.com/account/login")));
    // …but the console fails closed until CONSOLE_HOST (or ADMIN_HOST) is set.
    expectNotFound(middleware(makeRequest("https://example.com/console")));
    expectNotFound(middleware(makeRequest("https://my.example.com/console")));
  });

  it("MARKETING_HOST alone isolates marketing; unmatched hosts keep the customer surface", async () => {
    const middleware = await loadMiddleware({ MARKETING_HOST: "example.com" });
    expectPassThrough(middleware(makeRequest("https://example.com/about")));
    expectNotFound(middleware(makeRequest("https://example.com/account/login")));
    expectNotFound(middleware(makeRequest("https://example.com/api/account/portal")));
    expectPassThrough(middleware(makeRequest("https://other.test/account/login")));
    expectNotFound(middleware(makeRequest("https://other.test/console")));
  });
});
