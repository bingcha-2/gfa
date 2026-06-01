export class RemoteAccessHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly body?: unknown) {
    super(message);
  }

  toBody() {
    return this.body || { ok: false, error: this.message };
  }
}
