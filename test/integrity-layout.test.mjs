import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "esbuild";

async function loadModule(entryPoint) {
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
}

test("findCodeFileReferences detects module references to code file basenames", async () => {
  const { findCodeFileReferences } = await loadModule(
    "src/lib/scan-framer-local.ts"
  );

  const refs = findCodeFileReferences(
    'import TropicalAsciiCam from "https://framerusercontent.com/modules/id/version/TropicalAsciiCam.js"',
    ["TropicalAsciiCam.tsx", "Other.tsx"]
  );

  assert.deepEqual(refs, ["TropicalAsciiCam"]);
});

test("code file path drift flags nested path-sensitive files referenced by modules", async () => {
  const { findCodeFilePathDriftIssues } = await loadModule(
    "src/lib/code-file-integrity.ts"
  );

  const issues = findCodeFilePathDriftIssues({
    files: [
      {
        content:
          'import { addPropertyControls } from "framer"; export default function TropicalAsciiCam() { return null } addPropertyControls(TropicalAsciiCam, {})',
        id: "file-1",
        name: "TropicalAsciiCam.tsx",
        path: "Styles_Effects/TropicalAsciiCam.tsx",
      },
    ],
    instances: [
      {
        componentName: "FrameworksSection",
        id: "Oi7sXaJzC",
        insertURL: "https://framer.com/m/Section-E5phWG.js@hash",
      },
    ],
    moduleScans: [
      {
        codeFileReferences: ["TropicalAsciiCam"],
        locals: [],
        missing: [],
        ok: true,
        roots: ["https://framer.com/m/Section-E5phWG.js@hash"],
        url: "https://framerusercontent.com/modules/id/hash/D6WxmpEcN.js",
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].expectedRootPath, "TropicalAsciiCam.tsx");
  assert.deepEqual(issues[0].referencedBy[0].instanceIds, ["Oi7sXaJzC"]);
});

test("layout drift flags fill-width media components and likely text overflow", async () => {
  const { findLayoutDriftIssues } = await loadModule("src/lib/layout-drift.ts");

  const issues = findLayoutDriftIssues([
    {
      componentName: "VimeoPlayer",
      height: 360,
      id: "video-1",
      type: "ComponentInstanceNode",
      width: "1fr",
    },
    {
      height: 20,
      id: "text-1",
      name: "Narrow headline",
      text: "This is a long headline that will not fit inside the narrow fixed box",
      type: "TextNode",
      width: 120,
    },
  ]);

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.kind === "fill-size"));
  assert.ok(issues.some((issue) => issue.kind === "text-overflow-risk"));
});
