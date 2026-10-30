import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
const output = resolve(process.argv[2] ?? "release-package");
const p = JSON.parse(readFileSync("deploy/runtime-package.json", "utf8"));
for (const k of Object.keys(p.dependencies)) {
  p.dependencies[k] = JSON.parse(
    readFileSync(`node_modules/${k}/package.json`, "utf8"),
  ).version;
}
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "package.json"), JSON.stringify(p, null, 2) + "\n");
cpSync("dist-server", join(output, "dist-server"), { recursive: true });
cpSync("deploy", join(output, "deploy"), { recursive: true });
if (existsSync("deploy/runtime-lock.yaml"))
  cpSync("deploy/runtime-lock.yaml", join(output, "pnpm-lock.yaml"));
console.log(output);
