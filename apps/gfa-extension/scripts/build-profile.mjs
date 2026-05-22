import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const profile = process.argv[2] || "server";
const action = process.argv[3] || "build";

if (!["server", "client", "employee"].includes(profile)) {
  throw new Error(`Unknown build profile: ${profile}`);
}
if (!["build", "package"].includes(action)) {
  throw new Error(`Unknown action: ${action}`);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const env = {
  ...process.env,
  ROSETTA_DISTRIBUTION: profile,
  VITE_ROSETTA_DISTRIBUTION: profile,
};
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const profileMeta = {
  server: {
    name: "bcai-tools",
    displayName: "冰茶AI",
    description: "冰茶AI 智能编程助手 - 账号池管理与代理服务插件",
    title: "BCAI",
    configSection: "bcai",
    viewContainerId: "bcai-server-sidebar",
    viewId: "bcai.serverView",
    viewName: "BCAI",
  },
  client: {
    name: "bcai-rosetta-client",
    displayName: "冰茶AI",
    description: "冰茶AI temporary token client plugin",
    title: "冰茶AI",
    configSection: "bcai-client",
    viewContainerId: "bcai-client-sidebar",
    viewId: "bcai.clientView",
    viewName: "冰茶AI",
  },
  employee: {
    name: "bcai-account-assistant",
    displayName: "账号助手",
    description: "账号助手 - Rosetta employee account assistant plugin",
    title: "账号助手",
    configSection: "bcai-employee",
    viewContainerId: "bcai-account-assistant-sidebar",
    viewId: "bcai.accountAssistantView",
    viewName: "账号助手",
  },
};

function applyPackageProfile(originalPackage) {
  const meta = profileMeta[profile];
  const nextPackage = JSON.parse(originalPackage);
  nextPackage.name = meta.name;
  nextPackage.displayName = meta.displayName;
  nextPackage.description = meta.description;

  const container = nextPackage.contributes?.viewsContainers?.activitybar?.[0];
  if (container) {
    container.id = meta.viewContainerId;
    container.title = meta.title;
  }

  if (nextPackage.contributes?.views) {
    const sourceViews =
      nextPackage.contributes.views["bcai-sidebar"] ||
      nextPackage.contributes.views["bcai-server-sidebar"] ||
      [];
    nextPackage.contributes.views = {
      [meta.viewContainerId]: sourceViews.map((view) => ({
        ...view,
        id: meta.viewId,
        name: meta.viewName,
      })),
    };
  }

  if (nextPackage.contributes?.configuration) {
    nextPackage.contributes.configuration.title = meta.title;

    // Remap configuration property keys to profile-specific section names
    // so multiple BCAI plugins can coexist without VS Code key conflicts.
    const configSection = meta.configSection;
    if (configSection && configSection !== "bcai") {
      const oldProps = nextPackage.contributes.configuration.properties || {};
      const newProps = {};
      for (const [key, value] of Object.entries(oldProps)) {
        const newKey = key.replace(/^bcai\./, `${configSection}.`);
        newProps[newKey] = value;
      }
      nextPackage.contributes.configuration.properties = newProps;
    }
  }

  return nextPackage;
}

function withPackageProfile(fn) {
  const packagePath = join(root, "package.json");
  const originalPackage = readFileSync(packagePath, "utf8");
  writeFileSync(packagePath, `${JSON.stringify(applyPackageProfile(originalPackage), null, 2)}\n`, "utf8");
  try {
    fn();
  } finally {
    writeFileSync(packagePath, originalPackage, "utf8");
  }
}

function run(command, args) {
  console.log(`[build-profile] ${profile}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

withPackageProfile(() => {
  run(npmCmd, ["run", "build"]);

  if (action === "package") {
    mkdirSync(join(root, "release"), { recursive: true });
    const outName =
      profile === "client"
        ? `bcai-rosetta-client-${pkg.version}.vsix`
        : profile === "employee"
          ? `bcai-rosetta-employee-${pkg.version}.vsix`
          : `bcai-rosetta-server-${pkg.version}.vsix`;
    const args = [
      "@vscode/vsce",
      "package",
      "--no-dependencies",
      "--out",
      join("release", outName),
    ];
    // All profiles strip server-only files from the VSIX to prevent source
    // code leakage. The server admin runs remote-token-server directly from
    // the source tree via PM2, so it's not needed inside the extension package.
    const baseIgnore = readFileSync(join(root, ".vscodeignore"), "utf8");
    const ignoreFilePath = join(root, "release", `.vscodeignore-${profile}`);
    let ignoreContent = `${baseIgnore.trim()}\n` +
        "release/**\n" +
        "bundled-rosetta/remote-token-server/**\n" +
        "bundled-rosetta/start-remote-token-server.js\n" +
        "scripts/**\n";

    if (profile === "employee") {
        // Employee builds need puppeteer-core + all transitive deps for local
        // AdsPower automation. Instead of whitelisting individual packages (which
        // is fragile — @puppeteer/browsers alone pulls 60+ transitive deps),
        // we remove the blanket node_modules exclusion and only exclude the
        // native modules that employees don't need.
        ignoreContent = ignoreContent
          .split("\n")
          .filter(line => line.trim() !== "bundled-rosetta/node_modules/**")
          .join("\n");
        ignoreContent +=
          "bundled-rosetta/node_modules/better-sqlite3/**\n" +
          "bundled-rosetta/node_modules/prebuild-install/**\n" +
          "bundled-rosetta/node_modules/node-abi/**\n" +
          "bundled-rosetta/node_modules/node-addon-api/**\n";
    }

    writeFileSync(ignoreFilePath, ignoreContent, "utf8");
    args.push("--ignoreFile", ignoreFilePath);
    run(npxCmd, args);
  }
});
