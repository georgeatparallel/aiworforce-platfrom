// Detached worktree of one already-fetched SHA; no implementation branch edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOriginals } from "./assert-originals.mjs";

const sha = process.argv[2];
assert.match(
  sha ?? "",
  /^[a-f0-9]{40}$/,
  "Supply the exact fetched 40-character commit SHA",
);
assert.equal(
  execFileSync("git", ["cat-file", "-t", sha], { encoding: "utf8" }).trim(),
  "commit",
);
const preserved = assertOriginals();
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const directory = mkdtempSync("/tmp/agentory-pr90-retest-");
const sourceRoot = join(directory, "source");
const testRoot = join(directory, "tests");
execFileSync("git", ["worktree", "add", "--detach", sourceRoot, sha], {
  stdio: "pipe",
});
cpSync(fileURLToPath(new URL(".", import.meta.url)), testRoot, {
  recursive: true,
});
symlinkSync(join(repository, "node_modules"), join(directory, "node_modules"));
const original = JSON.parse(
  readFileSync(new URL("./source-pins.json", import.meta.url), "utf8"),
);
const pins = {
  ...original,
  head: sha,
  base: execFileSync("git", ["merge-base", sha, "origin/launch/hardening"], {
    encoding: "utf8",
  }).trim(),
  sha256: Object.fromEntries(
    Object.keys(original.sha256).map((path) => [
      path,
      createHash("sha256").update(readFileSync(join(sourceRoot, path))).digest(
        "hex",
      ),
    ]),
  ),
};
// Only this disposable copy's source pins change. Original tests stay identical.
writeFileSync(
  join(testRoot, "source-pins.json"),
  JSON.stringify(pins, null, 2) + "\n",
);
const testSha256 = Object.fromEntries([
  "verify.ts",
  "egress.ts",
  "polling.ts",
  "mutations.ts",
  "runtimeHarness.ts",
  "harness.ts",
].map((
  path,
) => [
  path,
  createHash("sha256").update(readFileSync(join(testRoot, path))).digest("hex"),
]));
const preparation = {
  schema: "pr90-retest-preparation-v1",
  ...preserved,
  reviewedSha: sha,
  sourceKind: "detached-git-worktree",
  sourceRoot,
  testRoot,
  pins,
  testSha256,
};
writeFileSync(
  join(directory, "preparation.json"),
  JSON.stringify(preparation, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    preparation: join(directory, "preparation.json"),
    reviewedSha: sha,
    sourceRoot,
    testRoot,
  }),
);
