import Link from "next/link";
import { headers } from "next/headers";
import { DownloadIcon, InfoIcon } from "lucide-react";

import { getDict } from "@/lib/i18n/server";
import { PageHeader } from "@/components/account/page-header";
import { AccountPill } from "@/components/account/account-ui";
import { fmt } from "@/lib/i18n";
import { marketingUrl } from "@/lib/marketing-url";

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
    <div className="account-download-card">
      <div>{title}</div>
      <p>{description}</p>
      <div className="account-download-card__meta">
        <div>
          {fmt(sizeTemplate, { size: toMb(asset.size) })}
        </div>
        <div title={asset.sha256}>
          {sha256Label}: {asset.sha256.slice(0, 16)}…
        </div>
      </div>
      <a className="account-btn account-btn--primary" href={asset.url} download>
        <DownloadIcon data-icon="inline-start" />
        {downloadLabel}
      </a>
    </div>
  );
}

export default async function AccountDownloadPage() {
  const dict = await getDict();
  const t = dict.portalApp;
  const d = t.downloadPage;

  const release = await fetchLatestRelease();

  return (
    <div className="account-download" data-testid="account-download">
      <PageHeader
        title={t.pages.downloadTitle}
        actions={
          release && (
            <AccountPill tone="info">
              {fmt(d.versionLabel, { version: release.version })}
            </AccountPill>
          )
        }
      />

      {release ? (
        <>
          {release.changelog && (
            <div className="account-download-changelog">
              <span>{d.changelogLabel}:</span>{" "}
              <span>{release.changelog}</span>
            </div>
          )}

          <div className="account-download-grid">
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
        <div className="account-empty">
          <strong>{d.loadFailedNotice}</strong>
          <Link
            href={marketingUrl("/download")}
            className="account-link"
          >
            {d.goMarketingDownload}
          </Link>
        </div>
      )}

      <div className="account-download-hint">
        <InfoIcon />
        <div>
          <div>{d.usageHintTitle}</div>
          <p>{d.usageHintBody}</p>
        </div>
      </div>
    </div>
  );
}
