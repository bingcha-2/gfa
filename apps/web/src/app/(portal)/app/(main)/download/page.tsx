import Link from "next/link";
import { headers } from "next/headers";
import { DownloadIcon, InfoIcon } from "lucide-react";

import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/portal/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/i18n";

export const dynamic = "force-dynamic";

type ReleaseAsset = { url: string; sha256: string; size: number };

type LatestWails = {
  version: string;
  url: string;
  sha256: string;
  size: number;
  installerUrl?: string;
  installerSha256?: string;
  installerSize?: number;
  changelog?: string;
  macOS?: { arm64?: ReleaseAsset; amd64?: ReleaseAsset };
  linux?: { amd64?: ReleaseAsset };
};

/**
 * Same-origin fetch of /updates/latest-wails.json (Caddy serves it from disk
 * in production; Next serves public/ in dev). Origin is derived from request
 * headers since server components have no implicit origin.
 */
async function fetchLatestRelease(): Promise<LatestWails | null> {
  try {
    const hdrs = await headers();
    const host = hdrs.get("host");
    if (!host) return null;
    const proto =
      hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    const resp = await fetch(`${proto}://${host}/updates/latest-wails.json`, {
      cache: "no-store",
    });
    if (!resp.ok) return null;
    return (await resp.json()) as LatestWails;
  } catch {
    return null;
  }
}

function toMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function AssetCard({
  title,
  description,
  asset,
  downloadLabel,
  sizeTemplate,
  sha256Label,
}: {
  title: string;
  description: string;
  asset: ReleaseAsset;
  downloadLabel: string;
  sizeTemplate: string;
  sha256Label: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 flex flex-col gap-3">
      <div className="font-medium">{title}</div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="tabular-nums">
          {fmt(sizeTemplate, { size: toMb(asset.size) })}
        </div>
        <div className="font-mono break-all" title={asset.sha256}>
          {sha256Label}: {asset.sha256.slice(0, 16)}…
        </div>
      </div>
      <Button
        className="mt-auto w-fit"
        nativeButton={false}
        render={<a href={asset.url} download />}
      >
        <DownloadIcon data-icon="inline-start" />
        {downloadLabel}
      </Button>
    </div>
  );
}

export default async function PortalDownloadPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  const d = t.downloadPage;

  const release = await fetchLatestRelease();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.pages.downloadTitle}
        actions={
          release && (
            <Badge variant="outline" className="tabular-nums">
              {fmt(d.versionLabel, { version: release.version })}
            </Badge>
          )
        }
      />

      {release ? (
        <>
          {release.changelog && (
            <div className="rounded-xl border bg-muted/30 p-4 text-sm">
              <span className="font-medium">{d.changelogLabel}:</span>{" "}
              <span className="text-muted-foreground">{release.changelog}</span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <AssetCard
              title={d.winPortable}
              description={d.winPortableDesc}
              asset={{
                url: release.url,
                sha256: release.sha256,
                size: release.size,
              }}
              downloadLabel={d.download}
              sizeTemplate={d.sizeMb}
              sha256Label={d.sha256Label}
            />

            {release.installerUrl && release.installerSha256 && (
              <AssetCard
                title={d.winInstaller}
                description={d.winInstallerDesc}
                asset={{
                  url: release.installerUrl,
                  sha256: release.installerSha256,
                  size: release.installerSize ?? 0,
                }}
                downloadLabel={d.download}
                sizeTemplate={d.sizeMb}
                sha256Label={d.sha256Label}
              />
            )}

            {release.macOS?.arm64 && (
              <AssetCard
                title={d.macArm}
                description={d.macDesc}
                asset={release.macOS.arm64}
                downloadLabel={d.download}
                sizeTemplate={d.sizeMb}
                sha256Label={d.sha256Label}
              />
            )}

            {release.macOS?.amd64 && (
              <AssetCard
                title={d.macIntel}
                description={d.macDesc}
                asset={release.macOS.amd64}
                downloadLabel={d.download}
                sizeTemplate={d.sizeMb}
                sha256Label={d.sha256Label}
              />
            )}

            {release.linux?.amd64 && (
              <AssetCard
                title={d.linux}
                description={d.linuxDesc}
                asset={release.linux.amd64}
                downloadLabel={d.download}
                sizeTemplate={d.sizeMb}
                sha256Label={d.sha256Label}
              />
            )}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed p-6 text-center space-y-3">
          <p className="text-sm text-muted-foreground">{d.loadFailedNotice}</p>
          <Link
            href="/download"
            className="inline-block text-sm text-accent underline-offset-4 hover:underline"
          >
            {d.goMarketingDownload}
          </Link>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-4">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-0.5 text-sm">
          <div className="font-medium">{d.usageHintTitle}</div>
          <p className="text-muted-foreground">{d.usageHintBody}</p>
        </div>
      </div>
    </div>
  );
}
