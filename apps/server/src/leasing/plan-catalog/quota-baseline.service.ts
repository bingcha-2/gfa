import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  BucketEntitlements,
  EntitlementInput,
  SupplyPolicyCatalog,
  buildFixedEntitlements,
  entitlementRatio,
  mergeSupplyPolicies,
  writePositive,
} from "./unified-entitlement";

@Injectable()
export class QuotaBaselineService {
  constructor(private readonly prisma: PrismaService) {}

  async buildEntitlements(catalog: SupplyPolicyCatalog, input: EntitlementInput): Promise<BucketEntitlements> {
    const entitlements = buildFixedEntitlements(catalog, input);
    const ratio = entitlementRatio(input);
    const policies = mergeSupplyPolicies(catalog);

    for (const product of input.products) {
      const policy = policies[product];
      if (!policy) continue;

      const selectedLevel = input.levels?.[product];
      for (const [bucket, source] of Object.entries(policy.buckets)) {
        if (source.source !== "learned") continue;
        const profile = await this.prisma.quotaProfile.findUnique({
          where: {
            provider_planType_family: {
              provider: source.provider,
              planType: selectedLevel || source.planType || policy.defaultLevel,
              family: source.family,
            },
          },
        });
        if (!profile) continue;

        writePositive(entitlements.bucketLimits, bucket, Math.floor(Number(profile.window5h) * ratio));
        writePositive(entitlements.weeklyBucketLimits, bucket, Math.floor(Number(profile.weekly) * ratio));
      }
    }

    return entitlements;
  }
}
