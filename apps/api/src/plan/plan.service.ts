import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { CreatePlanDto, UpdatePlanDto } from "./dto/plan.dto";

export const VALID_PRODUCTS = ["antigravity", "codex", "anthropic"] as const;
export type ValidProduct = (typeof VALID_PRODUCTS)[number];

/** Fields exposed to customers — internals are omitted. */
export interface PublicPlanShape {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationDays: number;
  products: string[];
  deviceLimit: number;
  weight: number;
  sortOrder: number;
}

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---- Shared validation helpers ----

  private validateProducts(products: string[]): void {
    if (!products || products.length === 0) {
      throw new BadRequestException("products must be a non-empty array");
    }

    const seen = new Set<string>();
    for (const p of products) {
      if (!(VALID_PRODUCTS as readonly string[]).includes(p)) {
        throw new BadRequestException(
          `Invalid product "${p}". Valid values: ${VALID_PRODUCTS.join(", ")}`
        );
      }
      if (seen.has(p)) {
        throw new BadRequestException(`Duplicate product "${p}" in products array`);
      }
      seen.add(p);
    }
  }

  private validateWeight(weight: number): void {
    if (weight < 1 || weight > 8) {
      throw new BadRequestException("weight must be an integer between 1 and 8");
    }
  }

  private validatePriceCents(priceCents: number): void {
    if (priceCents < 0) {
      throw new BadRequestException("priceCents must be >= 0");
    }
  }

  /**
   * Tri-state JSON column semantics for bucketLimits:
   * null → clear the field (store DB NULL); object → validate values are
   * positive integers, then stringify. (undefined is handled by callers: leave untouched.)
   */
  private normalizeBucketLimits(value: Record<string, number> | null): string | null {
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("bucketLimits must be an object map");
    }
    for (const [key, limit] of Object.entries(value)) {
      if (!Number.isInteger(limit) || (limit as number) <= 0) {
        throw new BadRequestException(
          `bucketLimits["${key}"] must be a positive integer`
        );
      }
    }
    return JSON.stringify(value);
  }

  /**
   * Tri-state JSON column semantics for levels:
   * null → clear the field (store DB NULL); object → validate values are
   * strings, then stringify. (undefined is handled by callers: leave untouched.)
   */
  private normalizeLevels(value: Record<string, string> | null): string | null {
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("levels must be an object map");
    }
    for (const [key, level] of Object.entries(value)) {
      if (typeof level !== "string") {
        throw new BadRequestException(`levels["${key}"] must be a string`);
      }
    }
    return JSON.stringify(value);
  }

  /**
   * Parse productEntitlements defensively — one corrupt row must not 500
   * the whole public catalog. Falls back to [] for the bad row and logs it.
   */
  private parseProductsSafe(plan: { id: string; productEntitlements: string }): string[] {
    try {
      const parsed = JSON.parse(plan.productEntitlements);
      if (!Array.isArray(parsed)) {
        this.logger.error(
          `Plan ${plan.id} has non-array productEntitlements; falling back to []`
        );
        return [];
      }
      return parsed;
    } catch (err) {
      this.logger.error(
        `Plan ${plan.id} has corrupt productEntitlements JSON; falling back to []: ${err}`
      );
      return [];
    }
  }

  // ---- Public catalog ----

  async listPublic(): Promise<{ plans: PublicPlanShape[] }> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
    });

    return {
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        priceCents: p.priceCents,
        durationDays: p.durationDays,
        products: this.parseProductsSafe(p),
        deviceLimit: p.deviceLimit,
        weight: p.weight,
        sortOrder: p.sortOrder,
      })),
    };
  }

  // ---- Console CRUD: list all ----

  async listAll() {
    const plans = await this.prisma.plan.findMany({
      orderBy: { sortOrder: "asc" },
    });

    return plans.map((p) => ({
      ...p,
      // Keep bucketLimits and levels as raw strings (stored JSON) for admin view
    }));
  }

  // ---- Console CRUD: create ----

  async create(dto: CreatePlanDto) {
    this.validateProducts(dto.products);
    this.validateWeight(dto.weight);
    this.validatePriceCents(dto.priceCents);

    const data: Prisma.PlanCreateInput = {
      name: dto.name,
      priceCents: dto.priceCents,
      durationDays: dto.durationDays,
      productEntitlements: JSON.stringify(dto.products),
      weight: dto.weight,
      deviceLimit: dto.deviceLimit,
      active: dto.active,
      sortOrder: dto.sortOrder,
      windowMs: dto.windowMs ?? 18000000,
    };

    if (dto.description !== undefined) data.description = dto.description;
    if (dto.bucketLimits !== undefined) {
      data.bucketLimits = this.normalizeBucketLimits(dto.bucketLimits);
    }
    if (dto.levels !== undefined) data.levels = this.normalizeLevels(dto.levels);
    if (dto.weeklyTokenLimit !== undefined) data.weeklyTokenLimit = dto.weeklyTokenLimit;

    return this.prisma.plan.create({ data });
  }

  // ---- Console CRUD: update ----

  async update(id: string, dto: UpdatePlanDto) {
    const existing = await this.prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Plan "${id}" not found`);

    if (dto.products !== undefined) {
      this.validateProducts(dto.products);
    }
    if (dto.weight !== undefined) {
      this.validateWeight(dto.weight);
    }
    if (dto.priceCents !== undefined) {
      this.validatePriceCents(dto.priceCents);
    }

    const data: Prisma.PlanUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.priceCents !== undefined) data.priceCents = dto.priceCents;
    if (dto.durationDays !== undefined) data.durationDays = dto.durationDays;
    if (dto.products !== undefined) data.productEntitlements = JSON.stringify(dto.products);
    if (dto.bucketLimits !== undefined) {
      data.bucketLimits = this.normalizeBucketLimits(dto.bucketLimits);
    }
    if (dto.levels !== undefined) data.levels = this.normalizeLevels(dto.levels);
    if (dto.weight !== undefined) data.weight = dto.weight;
    if (dto.deviceLimit !== undefined) data.deviceLimit = dto.deviceLimit;
    if (dto.weeklyTokenLimit !== undefined) data.weeklyTokenLimit = dto.weeklyTokenLimit;
    if (dto.windowMs !== undefined) data.windowMs = dto.windowMs;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.plan.update({ where: { id }, data });
  }

  // ---- Console CRUD: delete ----

  async delete(id: string) {
    const existing = await this.prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Plan "${id}" not found`);

    // Check for references
    const [subCount, orderCount] = await Promise.all([
      this.prisma.subscription.count({ where: { planId: id } }),
      this.prisma.planOrder.count({ where: { planId: id } }),
    ]);

    if (subCount > 0 || orderCount > 0) {
      throw new ConflictException({
        error: "PLAN_IN_USE",
        message:
          "This plan is referenced by existing subscriptions or orders. " +
          "Deactivate it (active=false) instead of deleting.",
      });
    }

    await this.prisma.plan.delete({ where: { id } });
    return { id, deleted: true };
  }
}
