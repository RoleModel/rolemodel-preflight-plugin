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

const modulePromise = loadModule("src/lib/organize-components.ts");

const MANIFEST = [
  {
    category: "Explore",
    displayName: "Button Pill",
    key: "ButtonPill",
    syncPath: "Explore/ButtonPill.tsx",
  },
  {
    category: "Navigation",
    displayName: "Nav Bar",
    key: "NavBar",
  },
  {
    category: "Uncategorized",
    displayName: "Mystery",
    key: "Mystery",
  },
];

test("detects code files with a corrupted slash-containing name", async () => {
  const { planComponentOrganization } = await modulePromise;

  const plan = planComponentOrganization({
    canvasComponents: [],
    codeFiles: [
      { id: "f1", name: "Navigation/Button.tsx", path: "Button.tsx" },
      { id: "f2", name: "NavBar.tsx", path: "NavBar.tsx" },
    ],
    manifestComponents: MANIFEST,
  });

  assert.deepEqual(plan.codeFileNameRepairs, [
    {
      currentName: "Navigation/Button.tsx",
      fileId: "f1",
      restoredName: "Button.tsx",
    },
  ]);
});

test("does not flag plain file names as needing repair", async () => {
  const { planComponentOrganization } = await modulePromise;

  const plan = planComponentOrganization({
    canvasComponents: [],
    codeFiles: [
      { id: "f1", name: "ButtonPill.tsx", path: "ButtonPill.tsx" },
      { id: "f2", name: "NavBar.tsx", path: "NavBar.tsx" },
    ],
    manifestComponents: MANIFEST,
  });

  assert.equal(plan.codeFileNameRepairs.length, 0);
});

test("suggests folders for every project component, matched or not", async () => {
  const { planComponentOrganization } = await modulePromise;

  const plan = planComponentOrganization({
    canvasComponents: [
      { componentName: "Nav Bar", name: "Nav Bar", nodeId: "c1" },
      { componentName: "Nav Bar", name: "Marketing/Nav Bar", nodeId: "c2" },
      { componentName: null, name: "Untracked", nodeId: "c3" },
      { componentName: null, name: "  ", nodeId: "c4" },
    ],
    codeFiles: [],
    manifestComponents: MANIFEST,
  });

  assert.equal(plan.canvasComponentSuggestions.length, 3);
  assert.deepEqual(plan.canvasComponentSuggestions[0], {
    baseName: "Nav Bar",
    currentFolder: "",
    nodeId: "c1",
    reason: "Suggested category: Navigation.",
    suggestedFolder: "Navigation",
  });

  const [, foldered, unmatched] = plan.canvasComponentSuggestions;
  assert.equal(foldered.currentFolder, "Marketing");
  assert.equal(foldered.baseName, "Nav Bar");

  assert.equal(unmatched.suggestedFolder, null);
  assert.match(unmatched.reason, /choose a folder/u);

  assert.ok(plan.folderOptions.includes("Marketing"));
  assert.ok(plan.folderOptions.includes("Navigation"));
  assert.equal(plan.skipped.filter((item) => item.name === "c4").length, 1);
});

test("reads the folder from componentName when the layer name has none", async () => {
  const { planComponentOrganization } = await modulePromise;

  const plan = planComponentOrganization({
    canvasComponents: [
      { componentName: "Hero/Nav Bar", name: "Nav Bar", nodeId: "c1" },
    ],
    codeFiles: [],
    extraFolderNames: ["Charts Diagrams", " /Messaging Blocks/ ", ""],
    manifestComponents: MANIFEST,
  });

  const [suggestion] = plan.canvasComponentSuggestions;
  assert.equal(suggestion.currentFolder, "Hero");
  assert.equal(suggestion.baseName, "Nav Bar");

  assert.ok(plan.folderOptions.includes("Hero"));
  assert.ok(plan.folderOptions.includes("Charts Diagrams"));
  assert.ok(plan.folderOptions.includes("Messaging Blocks"));
});

test("node-tree folderPath overrides slash-prefix parsing", async () => {
  const { planComponentOrganization } = await modulePromise;

  const plan = planComponentOrganization({
    canvasComponents: [
      {
        componentName: "Nav Bar",
        folderPath: "Messaging Blocks",
        name: "Nav Bar",
        nodeId: "c1",
      },
      { componentName: "Card", folderPath: "", name: "Card", nodeId: "c2" },
    ],
    codeFiles: [],
    manifestComponents: MANIFEST,
  });

  const [foldered, root] = plan.canvasComponentSuggestions;
  assert.equal(foldered.currentFolder, "Messaging Blocks");
  assert.equal(foldered.baseName, "Nav Bar");
  assert.equal(root.currentFolder, "");
  assert.ok(plan.folderOptions.includes("Messaging Blocks"));
});

test("folderFromComponentName extracts slash prefixes", async () => {
  const { folderFromComponentName } = await modulePromise;

  assert.equal(folderFromComponentName("Hero/Nav Bar"), "Hero");
  assert.equal(folderFromComponentName("A/B/Nav Bar"), "A/B");
  assert.equal(folderFromComponentName("Nav Bar"), "");
  assert.equal(folderFromComponentName(null), "");
});

test("componentNameForFolder builds and clears folder prefixes", async () => {
  const { componentNameForFolder } = await modulePromise;

  assert.equal(
    componentNameForFolder("Nav Bar", "Navigation"),
    "Navigation/Nav Bar"
  );
  assert.equal(
    componentNameForFolder("Nav Bar", " /Navigation/ "),
    "Navigation/Nav Bar"
  );
  assert.equal(componentNameForFolder("Nav Bar", ""), "Nav Bar");
  assert.equal(componentNameForFolder("Nav Bar", "  "), "Nav Bar");
});
