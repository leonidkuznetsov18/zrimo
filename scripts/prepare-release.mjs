import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Runs as the semantic-release `prepare` step, before the release commit is
// made: aligns every version-bearing file with the version the commit
// analysis decided on, then builds and packs the verified tarball that the
// GitHub release attaches.
const root = resolve(import.meta.dirname, "..");
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error(`Expected a stable semver version, got ${version}`);
}

execFileSync(
  "npm",
  ["version", version, "--no-git-tag-version", "--workspace", "web-doc"],
  { cwd: root, stdio: "inherit" },
);

const statusPath = resolve(root, "release-status.json");
const status = JSON.parse(await readFile(statusPath, "utf8"));
status.packageVersion = version;
status.reason = `semantic-release-${version}`;
delete status.publishedArtifact;
await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);

// Builds the package, packs it and runs the content policy over the tarball.
execFileSync("npm", ["run", "test:pack"], { cwd: root, stdio: "inherit" });
