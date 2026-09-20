import { CodexAccount, refreshCodexAccessToken } from "./codex-token-provider";
import { CodexUpstreamHttpError } from "./codex-upstream-error";

/** A confirmed 401 permits one retry. Network/403/429 failures never rotate tokens. */
export async function withCodexAccessToken<T>(
  account: CodexAccount,
  accountsFilePath: string,
  request: (token: string) => Promise<T>,
  initialToken?: string,
): Promise<T> {
  const token = initialToken ?? await refreshCodexAccessToken(account, { accountsFilePath });
  try { return await request(token); }
  catch (error) {
    if (!(error instanceof CodexUpstreamHttpError) || error.status !== 401) throw error;
    const refreshed = await refreshCodexAccessToken(account, { accountsFilePath, rejectedAccessToken: token });
    return request(refreshed);
  }
}
