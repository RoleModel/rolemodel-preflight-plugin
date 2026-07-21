import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "esbuild";

const loadModule = async (entryPoint) => {
  const result = await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    platform: "node",
    write: false,
  });

  const source = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
};

const modulePromise = loadModule("src/lib/broken-components.ts");

test("maps !missing module specifiers back to canvas instances", async () => {
  const { findBrokenComponentIssues } = await modulePromise;

  const issues = findBrokenComponentIssues({
    instances: [
      {
        componentName: "NavBar",
        id: "node-1",
        insertURL: "https://framer.com/m/NavBar-abc.js",
      },
      {
        componentName: "Hero",
        id: "node-2",
        insertURL: "https://framer.com/m/Hero-def.js",
      },
    ],
    moduleScans: [
      {
        codeFileReferences: [],
        locals: [],
        missing: ["!missing/../codeFile/Explore/ButtonPill.tsx"],
        ok: true,
        roots: ["https://framer.com/m/NavBar-abc.js"],
        status: 200,
        url: "https://framerusercontent.com/modules/x/y/WPLR8K1mq.js",
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "missing-module-import");
  assert.equal(issues[0].nodeId, "node-1");
  assert.equal(issues[0].componentName, "NavBar");
  assert.deepEqual(issues[0].specifiers, [
    "!missing/../codeFile/Explore/ButtonPill.tsx",
  ]);
});

test("parses missing code file paths and names them in details", async () => {
  const { findBrokenComponentIssues, parseMissingCodeFilePath } =
    await modulePromise;

  assert.equal(
    parseMissingCodeFilePath(
      "!missing/../codeFile/RoleModel/Utility/Button.tsx"
    ),
    "RoleModel/Utility/Button.tsx"
  );
  assert.equal(parseMissingCodeFilePath("!missing/whatever"), null);

  const issues = findBrokenComponentIssues({
    instances: [
      {
        componentName: "Nav Bar",
        id: "node-1",
        insertURL: "https://framer.com/m/NavBar-abc.js",
      },
    ],
    moduleScans: [
      {
        codeFileReferences: [],
        locals: [],
        missing: ["!missing/../codeFile/RoleModel/Utility/Button.tsx"],
        ok: true,
        roots: ["https://framer.com/m/NavBar-abc.js"],
        status: 200,
        url: "https://framerusercontent.com/modules/x/y/KNszwtEGW.js",
      },
    ],
  });

  assert.deepEqual(issues[0].missingFilePaths, [
    "RoleModel/Utility/Button.tsx",
  ]);
  assert.match(issues[0].detail, /Imports Button\.tsx/u);
  assert.match(issues[0].detail, /RoleModel\/Utility\/Button\.tsx/u);
  assert.doesNotMatch(issues[0].detail, /!missing/u);
});

test("reports broken modules with no linked instance (layout templates)", async () => {
  const { findBrokenComponentIssues } = await modulePromise;

  const issues = findBrokenComponentIssues({
    instances: [],
    moduleScans: [
      {
        codeFileReferences: [],
        locals: [],
        missing: ["!missing/../codeFile/Explore/ButtonPill.tsx"],
        ok: true,
        roots: ["https://framerusercontent.com/modules/x/y/WPLR8K1mq.js"],
        status: 200,
        url: "https://framerusercontent.com/modules/x/y/WPLR8K1mq.js",
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].nodeId, undefined);
  assert.match(issues[0].detail, /layout template/u);
});

test("flags suspicious insertURLs and runtime errors per instance", async () => {
  const { findBrokenComponentIssues } = await modulePromise;

  const issues = findBrokenComponentIssues({
    instances: [
      {
        componentName: "Ghost",
        id: "node-9",
        insertURL: "https://framer.com/m/404-abc.js",
      },
      {
        componentName: "Crashy",
        id: "node-10",
        insertURL: "https://framer.com/m/Crashy-xyz.js",
      },
    ],
    moduleScans: [],
    runtimeErrors: [
      {
        componentName: "Crashy",
        message: "Unable to resolve specifier '!missing/...'",
        nodeId: "node-10",
      },
    ],
  });

  const kinds = issues.map((issue) => issue.kind).toSorted();
  assert.deepEqual(kinds, ["runtime-error", "suspicious-insert-url"]);
  assert.ok(issues.every((issue) => issue.nodeId));
});

test("deduplicates repeat findings for the same instance and module", async () => {
  const { findBrokenComponentIssues } = await modulePromise;

  const scan = {
    codeFileReferences: [],
    locals: [],
    missing: ["!missing/a.tsx"],
    ok: true,
    roots: ["https://framer.com/m/NavBar-abc.js"],
    status: 200,
    url: "https://framerusercontent.com/modules/x/y/mod.js",
  };

  const issues = findBrokenComponentIssues({
    instances: [
      {
        componentName: "NavBar",
        id: "node-1",
        insertURL: "https://framer.com/m/NavBar-abc.js",
      },
    ],
    moduleScans: [scan, scan],
  });

  assert.equal(issues.length, 1);
});
