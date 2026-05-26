const STORAGE_KEY = "gfa-public-orders";
const MAX_RECORDS = 8;

export type PublicOrderRecord = {
  code: string;
  email: string;
  orderNo: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isRecord(value: unknown): value is PublicOrderRecord {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.code === "string" &&
    typeof c.email === "string" &&
    typeof c.orderNo === "string" &&
    typeof c.status === "string" &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string"
  );
}

function readRecords(): PublicOrderRecord[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}

function writeRecords(records: PublicOrderRecord[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
}

export function normalizeRedeemCode(value: string) {
  return value.trim().toUpperCase();
}

export function normalizeOrderNo(value: string) {
  return value.trim().toUpperCase();
}

export function getStoredPublicOrders() {
  return readRecords();
}

export function findStoredPublicOrderByCode(code: string) {
  return readRecords().find((item) => item.code === normalizeRedeemCode(code)) ?? null;
}

export function upsertStoredPublicOrder(record: PublicOrderRecord) {
  const next = [record, ...readRecords().filter((item) => item.code !== record.code && item.orderNo !== record.orderNo)];
  writeRecords(next);
}

export function updateStoredPublicOrder(orderNo: string, patch: Partial<Pick<PublicOrderRecord, "status" | "updatedAt">>) {
  const normalizedOrderNo = normalizeOrderNo(orderNo);
  const records = readRecords();
  const next = records.map((item) => {
    if (item.orderNo !== normalizedOrderNo) return item;
    return { ...item, ...patch, updatedAt: patch.updatedAt ?? item.updatedAt };
  });
  writeRecords(next);
}
