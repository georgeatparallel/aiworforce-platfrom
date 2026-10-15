// Read-only check: test names may gain bug IDs; test logic must remain intact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const originalCommit = "092d2e937031f0e4d09570e10260e93563d12f5d";
const files = [
  "verify.ts",
  "egress.ts",
  "polling.ts",
  "mutations.ts",
  "runtimeHarness.ts",
  "harness.ts",
];
const printer = ts.createPrinter({ removeComments: true });
function normalized(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(ast, [(ctx) => {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(ast) === "Deno" &&
        node.expression.name.text === "test" && node.arguments.length === 2
      ) {
        return ts.factory.updateCallExpression(
          node,
          node.expression,
          node.typeArguments,
          [
            ts.factory.createStringLiteral("review-test-name"),
            node.arguments[1],
          ],
        );
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return (node) => ts.visitNode(node, visit);
  }]);
  try {
    return printer.printFile(transformed.transformed[0]);
  } finally {
    transformed.dispose();
  }
}
export function assertOriginals() {
  for (const file of files) {
    const path = "tests/reviews/pr90/" + file;
    const original = execFileSync(
      "git",
      ["show", `${originalCommit}:${path}`],
      {
        encoding: "utf8",
      },
    );
    const current = readFileSync(new URL("./" + file, import.meta.url), "utf8");
    assert.equal(
      normalized(current, file),
      normalized(original, file),
      `${path}: assertions, fixtures or control flow changed from ${originalCommit}`,
    );
  }
  assert.equal(
    readFileSync(new URL("./source-pins.json", import.meta.url), "utf8"),
    execFileSync("git", [
      "show",
      `${originalCommit}:tests/reviews/pr90/source-pins.json`,
    ], { encoding: "utf8" }),
    "The original implementation fingerprint must remain immutable",
  );
  return {
    originalCommit,
    unchangedTestModules: files.length,
    testNamesExcluded: true,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(assertOriginals()));
}
