#!/usr/bin/env node

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildProductionSmokes,
  productionSmokeBundlePath,
  PRODUCTION_SMOKE_BUNDLES,
} from "./build-production-smokes.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runNodeScript(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filePath], {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`production smoke failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

async function main() {
  const name = process.argv[2];
  if (!name || !PRODUCTION_SMOKE_BUNDLES[name]) {
    throw new Error(
      `Usage: node scripts/run-production-smoke.mjs <${Object.keys(PRODUCTION_SMOKE_BUNDLES).join("|")}>`,
    );
  }

  const bundlePath = productionSmokeBundlePath(name);
  if (!(await fileExists(bundlePath))) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Missing prebuilt production smoke bundle ${path.relative(rootDir, bundlePath)}. Rebuild the app so postbuild can generate it.`,
      );
    }
    console.log(`[info] missing ${path.relative(rootDir, bundlePath)}; building locally`);
    await buildProductionSmokes({ only: [name] });
  }

  await runNodeScript(bundlePath);
}

main().catch((error) => {
  console.error(`[fail] ${error.message}`);
  process.exitCode = 1;
});
