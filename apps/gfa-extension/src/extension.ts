import * as vscode from "vscode";
import { WebviewProvider } from "./webview/WebviewProvider.js";
import { initRosettaHandler, setRosettaWebview, disposeRosettaHandler } from "./webview/rosettaHandler.js";

export function activate(context: vscode.ExtensionContext) {
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

export function deactivate() {}
