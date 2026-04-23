import * as vscode from "vscode";
import { handleMessage } from "./messageHandler.js";

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'bcai.welcomeView';

  private onWebviewReady?: (webview: vscode.Webview) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    onWebviewReady?: (webview: vscode.Webview) => void
  ) {
    this.onWebviewReady = onWebviewReady;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg) => handleMessage(msg, webviewView.webview, this.context),
      undefined,
      this.context.subscriptions
    );

    // Notify Rosetta handler that the webview is ready
    if (this.onWebviewReady) {
      this.onWebviewReady(webviewView.webview);
    }

    // Clear webview reference when panel is disposed (prevents posting to dead webview)
    webviewView.onDidDispose(() => {
      if (this.onWebviewReady) {
        this.onWebviewReady(null as any);
      }
    }, undefined, this.context.subscriptions);

    // Re-push state when panel becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.onWebviewReady) {
        this.onWebviewReady(webviewView.webview);
      }
    }, undefined, this.context.subscriptions);
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist");

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; connect-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>BCAI TOOLS</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
