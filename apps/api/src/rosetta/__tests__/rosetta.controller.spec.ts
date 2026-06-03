import { describe, expect, it, vi } from "vitest";

import { RosettaController } from "../rosetta.controller";

function makeController() {
  const rosetta = {
    bindAccessKey: vi.fn(() => ({ ok: true, key: { id: "c1" } })),
    unbindAccessKey: vi.fn(() => ({ ok: true, key: { id: "c1" } })),
    createAccessKey: vi.fn(() => ({ ok: true })),
  };
  const tokenServer = { reloadAccessKeys: vi.fn() };
  const remoteCodex = { reloadAccessKeys: vi.fn() };
  const remoteClaude = { reloadAccessKeys: vi.fn() };
  const controller = new RosettaController(
    rosetta as any,
    {} as any,
    {} as any,
    tokenServer as any,
    remoteCodex as any,
    remoteClaude as any,
  );
  return { controller, rosetta, tokenServer, remoteCodex, remoteClaude };
}

describe("RosettaController — static binding", () => {
  it("bindAccessKey delegates to the service and reloads BOTH pools", () => {
    const { controller, rosetta, tokenServer, remoteCodex } = makeController();
    const result = controller.bindAccessKey({ id: "c1", provider: "codex", accountId: 1 });
    expect(rosetta.bindAccessKey).toHaveBeenCalledWith({ id: "c1", provider: "codex", accountId: 1 });
    expect(tokenServer.reloadAccessKeys).toHaveBeenCalledTimes(1);
    expect(remoteCodex.reloadAccessKeys).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true });
  });

  it("unbindAccessKey reloads both pools", () => {
    const { controller, rosetta, tokenServer, remoteCodex } = makeController();
    controller.unbindAccessKey({ id: "c1" });
    expect(rosetta.unbindAccessKey).toHaveBeenCalledWith({ id: "c1" });
    expect(tokenServer.reloadAccessKeys).toHaveBeenCalledTimes(1);
    expect(remoteCodex.reloadAccessKeys).toHaveBeenCalledTimes(1);
  });

  it("createAccessKey reloads the codex pool too (not just antigravity)", () => {
    const { controller, remoteCodex } = makeController();
    controller.createAccessKey({ name: "x" });
    expect(remoteCodex.reloadAccessKeys).toHaveBeenCalledTimes(1);
  });

  it("createAccessKey reloads the claude pool too (so new claude bindings are visible)", () => {
    const { controller, remoteClaude } = makeController();
    controller.createAccessKey({ name: "x" });
    expect(remoteClaude.reloadAccessKeys).toHaveBeenCalledTimes(1);
  });

  it("bindAccessKey reloads the claude pool too", () => {
    const { controller, remoteClaude } = makeController();
    controller.bindAccessKey({ id: "c1", provider: "claude", accountId: 1 });
    expect(remoteClaude.reloadAccessKeys).toHaveBeenCalledTimes(1);
  });
});
