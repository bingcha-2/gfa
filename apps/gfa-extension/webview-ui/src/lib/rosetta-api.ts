/**
 * Rosetta Webview API — sends rosetta:* messages to the Extension Host
 * and listens for rosetta:state pushes.
 */

import type { RosettaState } from "./rosetta-types";
import { getVsCodeApi } from "./vscode-api";

/** Send a rosetta action to the Extension Host */
export function sendRosettaAction(type: string, payload?: any): void {
  const api = getVsCodeApi();
  if (api) {
    api.postMessage({ type, payload });
  }
}

/** Subscribe to rosetta:state pushes. Returns an unsubscribe function. */
export function onRosettaState(callback: (state: RosettaState) => void): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === "rosetta:state") {
      callback(data.payload as RosettaState);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/** Request a fresh state push */
export function requestRosettaState(): void {
  sendRosettaAction("rosetta:getState");
}

/** Request stored credential line for an account (email---password---totp format).
 *  Returns a promise that resolves with the credential line or rejects on error. */
export function requestCredentialLine(accountId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("获取凭据超时"));
    }, 5000);

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "rosetta:credentialsResult" && data?.payload?.accountId === accountId) {
        clearTimeout(timeout);
        window.removeEventListener("message", handler);
        if (data.payload.error) {
          reject(new Error(data.payload.error));
        } else {
          resolve(data.payload.credentialLine || "");
        }
      }
    };

    window.addEventListener("message", handler);
    sendRosettaAction("rosetta:getCredentials", { accountId });
  });
}
