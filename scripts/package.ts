import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
// This directory is generated; remove prior bundles so old assets are not shipped.
rmSync("dist-server", { recursive: true, force: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"],
  { stdio: "inherit" },
);
mkdirSync("dist-server/backend/vendor", { recursive: true });
cpSync("backend/vendor", "dist-server/backend/vendor", { recursive: true });
cpSync("dist", "dist-server/dist", { recursive: true });
cpSync("docs", "dist-server/docs", { recursive: true });
cpSync(".env.auth.example", "dist-server/.env.auth.example");
cpSync(".env.social.example", "dist-server/.env.social.example");
cpSync("backend/migrations", "dist-server/backend/migrations", {
  recursive: true,
});
const p = JSON.parse(readFileSync("package.json", "utf8"));
const deps = [
  "@kobalab/majiang-core",
  "express",
  "pg",
  "socket.io",
  "zod",
  "nodemailer",
];
writeFileSync(
  "deploy/runtime-package.json",
  JSON.stringify(
    {
      name: p.name,
      version: p.version,
      private: true,
      type: "module",
      engines: p.engines,
      dependencies: Object.fromEntries(deps.map((k) => [k, p.dependencies[k]])),
    },
    null,
    2,
  ) + "\n",
);

// Capacity client is packaged only for an isolated exercise.
if (process.argv.includes("--capacity")) {
  const { createRequire } = await import("node:module");
  const localRequire = createRequire(import.meta.url),
    viteRequire = createRequire(localRequire.resolve("vite"));
  viteRequire("esbuild").buildSync({
    entryPoints: ["scripts/load-v2.ts"],
    outfile: "dist-server/backend/src/load-v2.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["pg", "@kobalab/majiang-core", "@kobalab/majiang-core/*"],
    banner: {
      js: 'import {createRequire as capacityRequire} from "node:module";const require=capacityRequire(import.meta.url);',
    },
  });
}
const { createHash } = await import("node:crypto");
const { readdirSync } = await import("node:fs");
const { join } = await import("node:path");
const sourceHash = createHash("sha256");
function fingerprint(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) fingerprint(path);
    else {
      sourceHash.update(path);
      sourceHash.update(readFileSync(path));
    }
  }
}
for (const directory of ["backend", "frontend", "shared", "scripts"])
  fingerprint(directory);
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.server.json",
]) {
  sourceHash.update(file);
  sourceHash.update(readFileSync(file));
}
writeFileSync(
  "dist-server/release.json",
  JSON.stringify(
    {
      version: p.version,
      protocolVersion: "2.0",
      sourceSha256: sourceHash.digest("hex"),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
