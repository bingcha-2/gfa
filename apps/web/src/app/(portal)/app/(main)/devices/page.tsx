"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { PageHeader } from "@/components/portal/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { getDevices, renameDevice, revokeDevice } from "@/lib/user-api";
import type { PortalDevice } from "@/lib/user-types";
import { formatDateTime } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

function deviceLabel(device: PortalDevice, unnamed: string): string {
  if (device.name?.trim()) return device.name;
  if (device.deviceId) {
    return device.deviceId.length > 12
      ? `${device.deviceId.slice(0, 12)}…`
      : device.deviceId;
  }
  return unnamed;
}

export default function DevicesPage() {
  const dict = useDict();
  const t = dict.portalApp;
  const d = t.devices;

  const [data, setData] = useState<{
    devices: PortalDevice[];
    deviceLimit: number;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Rename dialog
  const [renameTarget, setRenameTarget] = useState<PortalDevice | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Revoke confirm
  const [revokeTarget, setRevokeTarget] = useState<PortalDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getDevices();
      setData(next);
      setLoadError(false);
    } catch {
      setData({ devices: [], deviceLimit: 0 });
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openRename(device: PortalDevice) {
    setRenameTarget(device);
    setRenameValue(device.name ?? "");
  }

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget || renaming) return;
    setRenaming(true);
    try {
      await renameDevice(renameTarget.id, renameValue.trim());
      toast.success(d.renamedToast);
      setRenameTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : d.loadFailed);
    } finally {
      setRenaming(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    try {
      await revokeDevice(revokeTarget.id);
      toast.success(d.revokedToast);
      setRevokeTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : d.loadFailed);
    } finally {
      setRevoking(false);
    }
  }

  const activeCount =
    data?.devices.filter((dev) => dev.status === "ACTIVE").length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.pages.devicesTitle}
        actions={
          data && (
            <Badge variant="outline" className="tabular-nums">
              {fmt(d.countBadge, { n: activeCount, limit: data.deviceLimit })}
            </Badge>
          )
        }
      />

      {loadError && (
        <p className="text-sm text-destructive">{d.loadFailed}</p>
      )}

      {data === null ? (
        <div className="space-y-2">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      ) : data.devices.length === 0 ? (
        <Empty className="border min-h-[280px]">
          <EmptyHeader>
            <EmptyTitle>{d.empty}</EmptyTitle>
            <EmptyDescription>{d.emptyDesc}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              href="/app/download"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              {d.emptyDownload}
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{d.colName}</TableHead>
                <TableHead>{d.colPlatform}</TableHead>
                <TableHead>{d.colStatus}</TableHead>
                <TableHead>{d.colLastSeen}</TableHead>
                <TableHead>{d.colLastIp}</TableHead>
                <TableHead className="text-right">{d.colActions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.devices.map((device) => {
                const revoked = device.status === "REVOKED";
                return (
                  <TableRow
                    key={device.id}
                    className={cn(revoked && "opacity-50")}
                  >
                    <TableCell
                      className={cn(
                        "font-medium",
                        !device.name?.trim() && "font-mono text-xs"
                      )}
                    >
                      {deviceLabel(device, d.unnamed)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {device.platform}
                    </TableCell>
                    <TableCell>
                      <Badge variant={revoked ? "ghost" : "secondary"}>
                        {revoked ? d.statusRevoked : d.statusActive}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {device.lastSeenAt
                        ? formatDateTime(device.lastSeenAt)
                        : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {device.lastIp ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {!revoked && (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openRename(device)}
                          >
                            <PencilIcon data-icon="inline-start" />
                            {d.rename}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRevokeTarget(device)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            {d.revoke}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ── 重命名弹窗 ──────────────────────────────────────────────────── */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{d.renameTitle}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRename} className="space-y-4">
            <Field>
              <FieldLabel>{d.renameLabel}</FieldLabel>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={d.renamePlaceholder}
                maxLength={64}
                required
                disabled={renaming}
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={renaming || !renameValue.trim()}>
                {renaming ? d.renaming : d.renameSave}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── 移除设备确认 ────────────────────────────────────────────────── */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{d.revokeConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget && (
                <span className="font-medium text-foreground">
                  {deviceLabel(revokeTarget, d.unnamed)}
                </span>
              )}{" "}
              {d.revokeConfirmDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>
              {d.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleRevoke}
              disabled={revoking}
            >
              {revoking ? d.revoking : d.revokeConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
