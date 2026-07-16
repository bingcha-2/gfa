// inject.mjs — 冰茶AI「Codex 皮肤通道」通用注入器。
//
// 通过本机回环 CDP 把用户皮肤(skin.css + 可选 extra.js)注入 Codex 桌面端渲染进程。
// 零依赖,需 Node ≥ 22(依赖全局 fetch / WebSocket)。
//
// 用法:
//   node inject.mjs --css <skin.css> [--js <extra.js>] [--port N] [--screenshot out.png]
//   node inject.mjs --watch --css <skin.css> [--js <extra.js>]   # 常驻,导航后自动重注入
//   node inject.mjs --verify [--port N]                          # 安装自检,输出 JSON
//   node inject.mjs --remove [--port N]                          # 还原官方外观
//
// 端口缺省从 ~/.bingchaai/codex-skin/state.json 读取。
//
// Adapted from Codex-Dream-Skin (https://github.com/Fei-Away/Codex-Dream-Skin), MIT License.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_PATH = path.join(os.homedir(), ".bingchaai", "codex-skin", "state.json");

function parseArgs(argv) {
  const options = { port: 0, mode: "once", css: null, js: null, screenshot: null, timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--css") options.css = path.resolve(argv[++i]);
    else if (arg === "--js") options.js = path.resolve(argv[++i]);
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--watch") options.mode = "watch";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--remove") options.mode = "remove";
    else if (arg === "--once") options.mode = "once";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if ((options.mode === "once" || options.mode === "watch") && !options.css) {
    throw new Error("--css <skin.css> is required for inject/watch mode");
  }
  return options;
}

async function resolvePort(options) {
  if (Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535) return options.port;
  try {
    const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    if (!state.enabled) {
      throw new Error("皮肤通道未开启:请在冰茶AI客户端 → Codex 设置 → 开启「皮肤调试通道」");
    }
    if (Number.isInteger(state.port) && state.port > 0) return state.port;
    throw new Error(`state.json 中缺少有效端口: ${STATE_PATH}`);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`未找到 ${STATE_PATH}:请在冰茶AI客户端开启「皮肤调试通道」,或用 --port 显式指定端口`);
    }
    throw error;
  }
}

class CdpSession {
  constructor(target) {
    this.target = target;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    if (!this.closed) this.ws.close();
    this.closed = true;
  }
}

async function waitForTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const pages = targets.filter((item) => item.type === "page" && item.url.startsWith("app://"));
      if (pages.length) return pages;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`No Codex renderer target on 127.0.0.1:${port}: ${lastError?.message ?? "timed out"}`);
}

// 通用安装器:注入 <style id="bcai-codex-skin-style">,MutationObserver + 定时器保活,
// cleanup 同时执行 extra.js 注册进 window.__BCAI_SKIN__.cleanups 的清理函数。幂等。
function buildInstaller(cssText) {
  return `((cssText) => {
    const KEY = "__BCAI_SKIN__";
    const STYLE_ID = "bcai-codex-skin-style";
    const prev = window[KEY];
    if (prev) {
      prev.observer?.disconnect();
      if (prev.timer) clearInterval(prev.timer);
      (prev.cleanups || []).splice(0).forEach((fn) => { try { fn(); } catch {} });
    }
    const state = { cleanups: [], version: "1" };
    const ensure = () => {
      const root = document.documentElement;
      if (!root) return;
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head || root).appendChild(style);
      }
      if (style.textContent !== cssText) style.textContent = cssText;
    };
    state.observer = new MutationObserver(() => {
      if (!document.getElementById(STYLE_ID)) ensure();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    state.timer = setInterval(ensure, 5000);
    state.cleanup = () => {
      state.observer?.disconnect();
      if (state.timer) clearInterval(state.timer);
      (state.cleanups || []).splice(0).forEach((fn) => { try { fn(); } catch {} });
      document.getElementById(STYLE_ID)?.remove();
      delete window[KEY];
      return true;
    };
    window[KEY] = state;
    ensure();
    return { installed: true };
  })(${JSON.stringify(cssText)})`;
}

const REMOVER = `(() => {
  const state = window.__BCAI_SKIN__;
  if (state?.cleanup) return state.cleanup();
  document.getElementById("bcai-codex-skin-style")?.remove();
  return true;
})()`;

const VERIFIER = `(() => {
  const style = document.getElementById("bcai-codex-skin-style");
  return {
    installed: Boolean(window.__BCAI_SKIN__),
    stylePresent: Boolean(style),
    styleBytes: style?.textContent?.length ?? 0,
    viewport: { width: innerWidth, height: innerHeight },
    documentOverflow: {
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    },
  };
})()`;

async function loadPayload(options) {
  const cssText = await fs.readFile(options.css, "utf8");
  const extraJs = options.js ? await fs.readFile(options.js, "utf8") : null;
  return { installer: buildInstaller(cssText), extraJs };
}

async function applyToSession(session, payload) {
  const result = await session.evaluate(payload.installer);
  if (payload.extraJs) await session.evaluate(payload.extraJs);
  return result;
}

async function capture(session, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
}

async function runOneShot(options, port) {
  const targets = await waitForTargets(port, options.timeoutMs);
  const payload = options.mode === "once" ? await loadPayload(options) : null;
  const results = [];
  for (const [index, target] of targets.entries()) {
    const session = await new CdpSession(target).open();
    try {
      let result;
      if (options.mode === "remove") result = await session.evaluate(REMOVER);
      else if (options.mode === "verify") result = await session.evaluate(VERIFIER);
      else {
        await applyToSession(session, payload);
        await new Promise((resolve) => setTimeout(resolve, 400));
        result = await session.evaluate(VERIFIER);
      }
      results.push({ targetId: target.id, title: target.title, url: target.url, result });
      // 多窗口(主窗口 + 挂件等)时首个目标用原路径,其余加 -2/-3 后缀,避免互相覆盖。
      if (options.screenshot) {
        const shot = index === 0
          ? options.screenshot
          : options.screenshot.replace(/(\.[A-Za-z0-9]+)$/, `-${index + 1}$1`);
        await capture(session, shot);
      }
    } finally {
      session.close();
    }
  }
  console.log(JSON.stringify({ mode: options.mode, port, targets: results }, null, 2));
  if (options.mode === "verify" && results.some((item) => !item.result.stylePresent)) process.exitCode = 2;
}

async function runWatch(options, port) {
  const payload = await loadPayload(options);
  const sessions = new Map();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    let targets = [];
    try {
      targets = await waitForTargets(port, 2000);
    } catch (error) {
      console.error(`[bcai-skin] ${new Date().toISOString()} ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const activeIds = new Set(targets.map((target) => target.id));
    for (const [id, session] of sessions) {
      if (!activeIds.has(id) || session.closed) {
        session.close();
        sessions.delete(id);
      }
    }

    for (const target of targets) {
      if (sessions.has(target.id)) continue;
      try {
        const session = await new CdpSession(target).open();
        session.on("Page.loadEventFired", () => {
          setTimeout(() => applyToSession(session, payload).catch((error) => {
            console.error(`[bcai-skin] reinject failed: ${error.message}`);
          }), 250);
        });
        await applyToSession(session, payload);
        sessions.set(target.id, session);
        console.log(`[bcai-skin] injected target ${target.id} (${target.title || target.url})`);
      } catch (error) {
        console.error(`[bcai-skin] inject failed for ${target.id}: ${error.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  for (const session of sessions.values()) session.close();
}

const options = parseArgs(process.argv.slice(2));
const port = await resolvePort(options);
if (options.mode === "watch") await runWatch(options, port);
else await runOneShot(options, port);
