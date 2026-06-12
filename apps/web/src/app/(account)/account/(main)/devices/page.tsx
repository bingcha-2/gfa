"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { PageHeader } from "@/components/account/page-header";
import {
  AccountButton,
  AccountEmpty,
  AccountInput,
  AccountPill,
  AccountSkeleton,
} from "@/components/account/account-ui";
import { AccountStatusBadge } from "@/components/account/account-status-badge";
import { getDevices, renameDevice, revokeDevice } from "@/lib/account/user-api";
import type { AccountDevice } from "@/lib/account/user-types";
import { formatDateTime } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

function deviceLabel(device: AccountDevice, unnamed: string): string {
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
    devices: AccountDevice[];
    deviceLimit: number;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Rename dialog
  const [renameTarget, setRenameTarget] = useState<AccountDevice | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Revoke confirm
  const [revokeTarget, setRevokeTarget] = useState<AccountDevice | null>(null);
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

  function openRename(device: AccountDevice) {
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
    <div className="account-devices" data-testid="account-devices">
      <PageHeader
        title={t.pages.devicesTitle}
        actions={
          data && (
            <AccountPill tone={activeCount >= data.deviceLimit ? "warning" : "info"}>
              {fmt(d.countBadge, { n: activeCount, limit: data.deviceLimit })}
            </AccountPill>
          )
        }
      />

      {loadError && (
        <p className="account-form-error">{d.loadFailed}</p>
      )}

      {data === null ? (
        <div className="account-skeleton-stack">
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
          <AccountSkeleton className="account-skeleton--row" />
        </div>
      ) : data.devices.length === 0 ? (
        <AccountEmpty title={d.empty} description={d.emptyDesc}>
            <Link
              href="/account/download"
              className="account-link"
            >
              {d.emptyDownload}
            </Link>
        </AccountEmpty>
      ) : (
        <div className="account-data-table">
          <table>
            <thead>
              <tr>
                <th>{d.colName}</th>
                <th>{d.colPlatform}</th>
                <th>{d.colStatus}</th>
                <th>{d.colLastSeen}</th>
                <th>{d.colLastIp}</th>
                <th className="account-data-table__number">{d.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {data.devices.map((device) => {
                const revoked = device.status === "REVOKED";
                return (
                  <tr
                    key={device.id}
                    data-revoked={revoked || undefined}
                  >
                    <td
                      className={cn(
                        "account-data-table__strong",
                        !device.name?.trim() && "account-data-table__mono"
                      )}
                    >
                      {deviceLabel(device, d.unnamed)}
                    </td>
                    <td className="account-data-table__muted">
                      {device.platform}
                    </td>
                    <td>
                      <AccountStatusBadge tone={revoked ? "muted" : "success"}>
                        {revoked ? d.statusRevoked : d.statusActive}
                      </AccountStatusBadge>
                    </td>
                    <td className="account-data-table__muted">
                      {device.lastSeenAt
                        ? formatDateTime(device.lastSeenAt)
                        : "—"}
                    </td>
                    <td className="account-data-table__mono account-data-table__muted">
                      {device.lastIp ?? "—"}
                    </td>
                    <td>
                      {!revoked && (
                        <div className="account-row-actions">
                          <AccountButton
                            variant="ghost"
                            className="account-btn--compact"
                            onClick={() => openRename(device)}
                          >
                            <PencilIcon data-icon="inline-start" />
                            {d.rename}
                          </AccountButton>
                          <AccountButton
                            variant="ghost"
                            className="account-btn--compact account-btn--danger"
                            onClick={() => setRevokeTarget(device)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            {d.revoke}
                          </AccountButton>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {renameTarget && (
        <div className="account-dialog" role="presentation">
          <button
            type="button"
            className="account-dialog__backdrop"
            aria-label="关闭重命名弹窗"
            onClick={() => setRenameTarget(null)}
          />
          <section
            className="account-dialog__panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-device-rename-title"
          >
            <header className="account-dialog__header">
              <div>
                <h2 id="account-device-rename-title">{d.renameTitle}</h2>
                <p>{deviceLabel(renameTarget, d.unnamed)}</p>
              </div>
              <button
                type="button"
                className="account-dialog__close"
                aria-label="关闭重命名弹窗"
                onClick={() => setRenameTarget(null)}
              >
                x
              </button>
            </header>
            <form onSubmit={handleRename} className="account-form-stack">
              <AccountInput
                label={d.renameLabel}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={d.renamePlaceholder}
                maxLength={64}
                required
                disabled={renaming}
                autoFocus
              />
              <div className="account-form-actions">
                <AccountButton type="submit" disabled={renaming || !renameValue.trim()}>
                {renaming ? d.renaming : d.renameSave}
                </AccountButton>
              </div>
            </form>
          </section>
        </div>
      )}

      {revokeTarget && (
        <div className="account-dialog" role="presentation">
          <button
            type="button"
            className="account-dialog__backdrop"
            aria-label="关闭移除设备确认"
            onClick={() => setRevokeTarget(null)}
          />
          <section
            className="account-dialog__panel account-dialog__panel--narrow"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="account-device-revoke-title"
          >
            <header className="account-dialog__header">
              <div>
                <h2 id="account-device-revoke-title">{d.revokeConfirmTitle}</h2>
                <p>
              {revokeTarget && (
                    <strong>
                  {deviceLabel(revokeTarget, d.unnamed)}
                    </strong>
              )}{" "}
              {d.revokeConfirmDesc}
                </p>
              </div>
            </header>
            <div className="account-form-actions">
              <AccountButton
                type="button"
                variant="secondary"
                disabled={revoking}
                onClick={() => setRevokeTarget(null)}
              >
              {d.cancel}
              </AccountButton>
              <AccountButton
                type="button"
                className="account-btn--danger"
                onClick={handleRevoke}
                disabled={revoking}
              >
              {revoking ? d.revoking : d.revokeConfirm}
              </AccountButton>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
