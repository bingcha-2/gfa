# GFA Windows migration kit

This kit migrates the current GFA installation without creating a second copy of
the 4 GB production database on the source disk.

## 1. Map a target drive over RDP

Before opening the RDP connection, enable **Local Resources -> More -> Drives**.
Inside the source server, the mapped target drive appears below `\\tsclient`.
Create a destination directory on that mapped drive, for example:

```powershell
New-Item -ItemType Directory -Force '\\tsclient\C\GFA-transfer'
```

## 2. Create the migration set on the mapped drive

GFA and AdsPower must be stopped. The preparation script verifies that the
database and AdsPower profile files are not changing.

```powershell
Set-Location D:\GFA-per
powershell -ExecutionPolicy Bypass -File .\migration-kit\prepare-source.ps1 `
  -OutputDirectory '\\tsclient\C\GFA-transfer'
```

The output contains separate archives for code, the production SQLite database,
historical backups, Caddy, AdsPower program files, and AdsPower user data. It also
contains `manifest.json` with SHA-256 hashes. The archives contain secrets from
`.env` and browser profiles; keep the directory private.

## 3. Install on the target host

Run PowerShell as Administrator on the target host:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GFA-transfer\GFA-migration-*\install-target.ps1 `
  -MigrationDirectory C:\GFA-transfer\GFA-migration-* `
  -InstallRoot C:\GFA
```

The installer verifies all hashes, restores the files, installs Node.js LTS and
pnpm 10.27.0 when needed, installs dependencies, and generates the Prisma client.
It does not apply database migrations to the copied production database.

## 4. Start and verify before DNS cutover

```powershell
powershell -ExecutionPolicy Bypass -File C:\GFA\migration-kit\start-target.ps1 `
  -InstallRoot C:\GFA `
  -SkipCaddy
```

After local Web/API validation, point the DNS A records for `bcai.lol`,
`console.bcai.lol`, `my.bcai.lol`, and `api.bcai.lol` to the new server. Then run
the same command without `-SkipCaddy`. Caddy will request fresh certificates.

AdsPower is restored for the Administrator profile, but it remains a desktop
application: log in once, start it, and confirm `http://127.0.0.1:50325/` responds.
