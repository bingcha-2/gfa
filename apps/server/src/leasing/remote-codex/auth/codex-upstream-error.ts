/** A response status, not a status number guessed from an upstream message. */
export class CodexUpstreamHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CodexUpstreamHttpError";
  }
}
