#!/usr/bin/env node
/**
 * Seed demo swap data for testing the swap history UI.
 * Run: node scripts/seed-swap-demo.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Grab the first two family groups
  const groups = await prisma.familyGroup.findMany({
    take: 2,
    select: { id: true, accountId: true, groupName: true },
  });

  if (groups.length === 0) {
    console.error("No family groups found. Run the main seed first.");
    process.exit(1);
  }

  const g1 = groups[0];
  const g2 = groups[1] ?? groups[0];
  const now = new Date();

  console.log(`Using groups: ${g1.groupName} (${g1.id}), ${g2.groupName} (${g2.id})`);

  // ── 1. Create RedeemCodes ──────────────────────────────────────
  const swapCode = await prisma.redeemCode.create({
    data: {
      code: "HH-DEMO-SWAP-001",
      product: "GOOGLE_ONE",
      codeType: "ACCOUNT_SWAP",
      status: "USED",
      usedAt: now,
    },
  });

  const subCode = await prisma.redeemCode.create({
    data: {
      code: "CX-DEMO-SUB-001",
      product: "GOOGLE_ONE",
      codeType: "SUBSCRIPTION",
      status: "USED",
      usedAt: new Date(now.getTime() - 7 * 86400000),
      expiresAt: new Date(now.getTime() + 90 * 86400000),
      validDays: 90,
      swapLimit: 3,
      swapWindowHours: 5,
    },
  });

  const joinCode = await prisma.redeemCode.create({
    data: {
      code: "JG-DEMO-JOIN-001",
      product: "GOOGLE_ONE",
      codeType: "JOIN_GROUP",
      status: "USED",
      usedAt: new Date(now.getTime() - 14 * 86400000),
    },
  });

  console.log("Created redeem codes:", swapCode.code, subCode.code, joinCode.code);

  // ── 2. Create Orders ──────────────────────────────────────────
  // Order 1: JOIN type (no swap records)
  const joinOrder = await prisma.order.create({
    data: {
      orderNo: "GFA-DEMO-JOIN01",
      orderType: "JOIN",
      redeemCodeId: joinCode.id,
      userEmail: "alice@gmail.com",
      familyGroupId: g1.id,
      status: "COMPLETED",
      resultMessage: "Successfully invited to family group",
      expiresAt: new Date(now.getTime() + 30 * 86400000),
    },
  });

  // Order 2: SWAP type (one-time swap, 1 swap record)
  const swapOrder = await prisma.order.create({
    data: {
      orderNo: "GFA-DEMO-SWAP01",
      orderType: "SWAP",
      redeemCodeId: swapCode.id,
      userEmail: "charlie@gmail.com",
      familyGroupId: g1.id,
      status: "COMPLETED",
      resultMessage: "Account swap completed successfully",
    },
  });

  // Order 3: SUBSCRIPTION type (multiple swap records)
  const subOrder = await prisma.order.create({
    data: {
      orderNo: "GFA-DEMO-SUB01",
      orderType: "SUBSCRIPTION",
      redeemCodeId: subCode.id,
      userEmail: "eve@gmail.com",
      familyGroupId: g2.id,
      status: "COMPLETED",
      swapCount: 3,
      lastSwapAt: new Date(now.getTime() - 1 * 86400000),
      expiresAt: new Date(now.getTime() + 60 * 86400000),
      resultMessage: "Subscription active",
    },
  });

  console.log("Created orders:", joinOrder.orderNo, swapOrder.orderNo, subOrder.orderNo);

  // ── 3. Create SwapRecords ──────────────────────────────────────
  // SWAP order: 1 record
  await prisma.swapRecord.create({
    data: {
      orderId: swapOrder.id,
      oldEmail: "bob@gmail.com",
      newEmail: "charlie@gmail.com",
      status: "COMPLETED",
      createdAt: new Date(now.getTime() - 2 * 86400000),
    },
  });

  // SUBSCRIPTION order: 3 records (showing history)
  await prisma.swapRecord.create({
    data: {
      orderId: subOrder.id,
      oldEmail: "alice-sub@gmail.com",
      newEmail: "bob-sub@gmail.com",
      status: "COMPLETED",
      createdAt: new Date(now.getTime() - 7 * 86400000),
    },
  });

  await prisma.swapRecord.create({
    data: {
      orderId: subOrder.id,
      oldEmail: "bob-sub@gmail.com",
      newEmail: "charlie-sub@gmail.com",
      status: "COMPLETED",
      createdAt: new Date(now.getTime() - 3 * 86400000),
    },
  });

  await prisma.swapRecord.create({
    data: {
      orderId: subOrder.id,
      oldEmail: "charlie-sub@gmail.com",
      newEmail: "eve@gmail.com",
      status: "COMPLETED",
      createdAt: new Date(now.getTime() - 1 * 86400000),
    },
  });

  // Add a PENDING swap record (in-progress) for variety
  await prisma.swapRecord.create({
    data: {
      orderId: subOrder.id,
      oldEmail: "eve@gmail.com",
      newEmail: "frank@gmail.com",
      status: "PENDING",
      createdAt: now,
    },
  });

  console.log("Created swap records (1 for SWAP order, 4 for SUBSCRIPTION order)");
  console.log("\n✅ Demo data seeded! Start the API + Web and check the orders panel.");
  console.log("   → SWAP order: GFA-DEMO-SWAP01 (1 swap record)");
  console.log("   → SUBSCRIPTION order: GFA-DEMO-SUB01 (4 swap records with history chain)");
  console.log("   → JOIN order: GFA-DEMO-JOIN01 (no swap records - should not show section)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
