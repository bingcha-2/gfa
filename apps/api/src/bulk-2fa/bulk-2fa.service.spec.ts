import { describe, expect, it, afterEach } from "vitest";
import { Bulk2faService } from "./bulk-2fa.service";
import * as fs from "fs";
import * as path from "path";

describe("Bulk2faService - createJob parsing", () => {
  const mockQueue = { add: () => Promise.resolve() } as any;
  const dataDir = "C:/Users/Administrator/Desktop/GFA/data/bulk-2fa";
  const service = new Bulk2faService(mockQueue);

  afterEach(() => {
    // Clean up created job files after test
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir).filter(f => f.startsWith("job_") && f.endsWith(".json"));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dataDir, file));
        } catch {}
      }
    }
  });

  it("should correctly parse and classify columns when recovery email and TOTP secret are reversed", async () => {
    const text = "ParaaMarie647@gmail.com----ycbzttayda----ParaaMarie64718143@westt.site----https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th";
    const job = await service.createJob(text);
    expect(job.items).toHaveLength(1);
    expect(job.items[0].email).toBe("ParaaMarie647@gmail.com");
    expect(job.items[0].password).toBe("ycbzttayda");
    expect(job.items[0].recoveryEmail).toBe("ParaaMarie64718143@westt.site");
    expect(job.items[0].oldSecret).toBe("UEKAMA7ND3EKDHIQ4FOHUGDBGW3YM6TH");
  });

  it("should support multi-line continuation records", async () => {
    const text = [
      "ParaaMarie647@gmail.com----ycbzttayda----",
      "ParaaMarie64718143@westt.site----",
      "https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th"
    ].join("\n");
    const job = await service.createJob(text);
    expect(job.items).toHaveLength(1);
    expect(job.items[0].email).toBe("ParaaMarie647@gmail.com");
    expect(job.items[0].password).toBe("ycbzttayda");
    expect(job.items[0].recoveryEmail).toBe("ParaaMarie64718143@westt.site");
    expect(job.items[0].oldSecret).toBe("UEKAMA7ND3EKDHIQ4FOHUGDBGW3YM6TH");
    // Verify rawLine is merged as a single flat string
    expect(job.items[0].rawLine).toBe("ParaaMarie647@gmail.com----ycbzttayda----ParaaMarie64718143@westt.site----https://2fa.live/tok/uekama7nd3ekdhiq4fohugdbgw3ym6th");
  });
});
