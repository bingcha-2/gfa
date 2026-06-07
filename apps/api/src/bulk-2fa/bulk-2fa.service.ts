import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import * as fs from "fs";
import * as path from "path";
import { QUEUE_NAMES } from "@gfa/shared";

export interface BulkJobItem {
  id: string;
  rawLine: string;
  email: string;
  password: string;
  oldSecret?: string;
  recoveryEmail?: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  newSecret?: string;
  error?: string;
  screenshot?: string;
  updatedAt: string;
}

export interface BulkJob {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  items: BulkJobItem[];
}

@Injectable()
export class Bulk2faService {
  private readonly dataDir = "C:/Users/Administrator/Desktop/GFA/data/bulk-2fa";

  constructor(
    @InjectQueue(QUEUE_NAMES.bulk2fa)
    private readonly queue: Queue
  ) {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getJobPath(jobId: string): string {
    return path.join(this.dataDir, `job_${jobId}.json`);
  }

  private extractTotp(raw: string): string {
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/2fa\.live\/tok\/([a-z0-9]+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    return trimmed.replace(/[\s\-=]/g, "").toUpperCase();
  }

  private classifyField(value: string): "email" | "totp" {
    const trimmed = value.trim();
    if (trimmed.includes("@")) return "email";
    return "totp";
  }

  async createJob(text: string): Promise<BulkJob> {
    const jobId = `job_${Date.now()}`;
    const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    
    interface ParsedItem {
      email: string;
      password: string;
      oldSecret?: string;
      recoveryEmail?: string;
      rawLines: string[];
    }
    const parsedItems: ParsedItem[] = [];
    let currentItem: ParsedItem | null = null;

    for (const line of rawLines) {
      const parts = line.split(/-{3,}|,|\||\t/).map(p => p.trim());
      const firstPart = parts[0] || "";
      const secondPart = parts[1] || "";
      
      const isNewAccount = firstPart.includes("@") && secondPart !== "";

      if (isNewAccount) {
        currentItem = {
          email: firstPart,
          password: secondPart,
          rawLines: [line]
        };
        parsedItems.push(currentItem);
        
        const extra = parts.slice(2).filter(Boolean);
        for (const field of extra) {
          const kind = this.classifyField(field);
          if (kind === "email" && !currentItem.recoveryEmail) {
            currentItem.recoveryEmail = field;
          } else if (kind === "totp" && !currentItem.oldSecret) {
            currentItem.oldSecret = this.extractTotp(field);
          }
        }
      } else if (currentItem) {
        currentItem.rawLines.push(line);
        const extra = parts.filter(Boolean);
        for (const field of extra) {
          const kind = this.classifyField(field);
          if (kind === "email" && !currentItem.recoveryEmail) {
            currentItem.recoveryEmail = field;
          } else if (kind === "totp" && !currentItem.oldSecret) {
            currentItem.oldSecret = this.extractTotp(field);
          }
        }
      }
    }

    const items: BulkJobItem[] = parsedItems.map((pi, idx) => {
      const cleanedLines = pi.rawLines.map(l => l.replace(/-{3,}\s*$/, ""));
      return {
        id: `item_${idx + 1}`,
        rawLine: cleanedLines.join("----"),
        email: pi.email,
        password: pi.password,
        oldSecret: pi.oldSecret,
        recoveryEmail: pi.recoveryEmail,
        status: "PENDING",
        updatedAt: new Date().toISOString()
      };
    });

    const job: BulkJob = {
      id: jobId,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items
    };

    fs.writeFileSync(this.getJobPath(jobId), JSON.stringify(job, null, 2), "utf8");
    
    // Enqueue the job for worker processing
    await this.queue.add("process-bulk", { jobId }, {
      attempts: 1,
      jobId: `bulk-2fa-${jobId}`
    });

    return job;
  }

  async getJob(jobId: string): Promise<BulkJob> {
    const filePath = this.getJobPath(jobId);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException("Job not found");
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  async listJobs(): Promise<Omit<BulkJob, "items">[]> {
    if (!fs.existsSync(this.dataDir)) return [];
    const files = fs.readdirSync(this.dataDir).filter(f => f.startsWith("job_") && f.endsWith(".json"));
    
    const jobs = files.map(file => {
      try {
        const filePath = path.join(this.dataDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as BulkJob;
        return {
          id: data.id,
          status: data.status,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          totalItems: data.items.length,
          successCount: data.items.filter(i => i.status === "SUCCESS").length,
          failedCount: data.items.filter(i => i.status === "FAILED").length
        };
      } catch {
        return null;
      }
    }).filter(Boolean) as any[];

    // Sort by creation time desc
    return jobs.sort((a, b) => b.id.localeCompare(a.id));
  }

  async getDownloadData(jobId: string, type: "success" | "failed"): Promise<string> {
    const job = await this.getJob(jobId);
    const filtered = job.items.filter(item => item.status === (type === "success" ? "SUCCESS" : "FAILED"));
    
    return filtered.map(item => {
      const parts = item.rawLine.split(/----+|,|\||\t/).map(p => p.trim());
      if (type === "success" && item.newSecret) {
        // Replace the old secret (typically 3rd column) with new secret, or append it
        if (parts.length >= 3) {
          parts[2] = item.newSecret;
        } else {
          parts.push(item.newSecret);
        }
        return parts.join("----");
      } else if (type === "failed") {
        return `${item.rawLine} ---- Error: ${item.error || "Unknown error"}`;
      }
      return item.rawLine;
    }).join("\r\n");
  }
}
