"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyIcon, GiftIcon, UsersIcon, WalletIcon } from "lucide-react";

import { PageHeader } from "@/components/account/page-header";
import { StatCard } from "@/components/account/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getReferral } from "@/lib/account/user-api";
import type { ReferralInfo } from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { formatPriceCents } from "@/lib/account/format-extensions";
import { useDict } from "@/lib/i18n/client";

export default function ReferralPage() {
  const dict = useDict();
  const t = dict.portalApp;
  const r = t.referral;

  const [data, setData] = useState<ReferralInfo | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    getReferral()
      .then(setData)
      .catch(() => setLoadError(true));
  }, []);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(r.copiedToast);
    } catch {
      toast.error(r.copyFailed);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t.pages.referralTitle} />

      {loadError && <p className="text-sm text-destructive">{r.loadFailed}</p>}

      {data === null && !loadError ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label={r.statInvited}
              value={data.invitees.length}
              icon={<UsersIcon />}
            />
            <StatCard
              label={r.statRewards}
              value={formatPriceCents(data.rewards.totalCents)}
              sub={`× ${data.rewards.grantedCount}`}
              icon={<GiftIcon />}
            />
            <StatCard
              label={r.statCredit}
              value={formatPriceCents(data.creditCents)}
              icon={<WalletIcon />}
            />
          </div>

          <div className="rounded-xl border bg-card p-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  {r.codeLabel}
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={data.referralCode}
                    className="font-mono"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void copyText(data.referralCode)}
                  >
                    <CopyIcon data-icon="inline-start" />
                    {r.copy}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  {r.linkLabel}
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={data.referralLink}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void copyText(data.referralLink)}
                  >
                    <CopyIcon data-icon="inline-start" />
                    {r.copy}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <section className="space-y-4">
            <h3 className="text-sm font-medium">{r.inviteesSection}</h3>

            {data.invitees.length === 0 ? (
              <Empty className="border min-h-[180px]">
                <EmptyHeader>
                  <EmptyTitle>{r.empty}</EmptyTitle>
                  <EmptyDescription>{r.emptyDesc}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="rounded-xl border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{r.colEmail}</TableHead>
                      <TableHead>{r.colRegisteredAt}</TableHead>
                      <TableHead>{r.colRewarded}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invitees.map((invitee) => (
                      <TableRow key={`${invitee.email}-${invitee.registeredAt}`}>
                        <TableCell>{invitee.email}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {formatDateTime(invitee.registeredAt)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={invitee.rewarded ? "secondary" : "outline"}
                          >
                            {invitee.rewarded ? r.rewardedYes : r.rewardedNo}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
