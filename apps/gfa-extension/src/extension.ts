import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebviewProvider } from "./webview/WebviewProvider.js";
import { initRosettaHandler, setRosettaWebview, disposeRosettaHandler } from "./webview/rosettaHandler.js";
import { clearRosettaIdeCloudCodeUrl, isRosettaCloudCodeUrl } from "./webview/rosettaState.js";

function readRosettaProxyConfig(): any {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const configPath = path.join(appData, "Antigravity", "rosetta", "proxy.config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function getConfiguredRosettaProxyUrl(): string {
  const config = readRosettaProxyConfig();
  const mode = String(
    config?.tokenProxyMode ||
    config?.tokenSource ||
    config?.relayProxy?.tokenSource ||
    ""
  ).trim().toLowerCase();
  const remoteMode = mode === "remote" || mode === "relay" || mode === "token-passthrough";
  if (!remoteMode) return "";
  const port = Number(config?.tokenProxyPort) || 60670;
  return `http://127.0.0.1:${port}`;
}

function syncIdeProxySettingForConfiguredMode(): void {
  const desiredUrl = getConfiguredRosettaProxyUrl();
  const current = String(vscode.workspace.getConfiguration("jetski").get("cloudCodeUrl") || "");

  if (desiredUrl) {
    if (current.trim() !== desiredUrl) {
      vscode.workspace
        .getConfiguration("jetski")
        .update("cloudCodeUrl", desiredUrl, vscode.ConfigurationTarget.Global)
        .then(undefined, () => undefined);
    }
    return;
  }

  let cleared = false;
  try { cleared = clearRosettaIdeCloudCodeUrl(); } catch { /* best effort */ }
  if (cleared || isRosettaCloudCodeUrl(current)) {
    vscode.workspace
      .getConfiguration("jetski")
      .update("cloudCodeUrl", undefined, vscode.ConfigurationTarget.Global)
      .then(undefined, () => undefined);
  }
}

export function activate(context: vscode.ExtensionContext) {
  syncIdeProxySettingForConfiguredMode();

  const outputChannel = vscode.window.createOutputChannel("BCAI Rosetta");
  initRosettaHandler(context, outputChannel);

  const provider = new WebviewProvider(context, (webview) => {
    setRosettaWebview(webview);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, provider),
    outputChannel,
    { dispose: () => disposeRosettaHandler() }
  );
}

export function deactivate() {
  disposeRosettaHandler();
}
