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

const modulePromise = loadModule("src/lib/usage-finder.ts");

test("finds code files referencing a query, case-insensitively", async () => {
  const { findComponentUsages } = await modulePromise;

  const matches = findComponentUsages({
    codeFiles: [
      {
        content: 'import Button from "https://framer.com/m/Button-0rIM19.js"',
        name: "FeatureSlider.tsx",
        path: "FeatureSlider.tsx",
      },
      {
        content: 'import Card from "https://framer.com/m/Card-abc123.js"',
        name: "ShapeCard.tsx",
        path: "ShapeCard.tsx",
      },
    ],
    instances: [],
    query: "button-0rim19",
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "code-file");
  assert.equal(matches[0].path, "FeatureSlider.tsx");
  assert.equal(matches[0].matchCount, 1);
});

test("counts multiple occurrences within one file", async () => {
  const { findComponentUsages } = await modulePromise;

  const matches = findComponentUsages({
    codeFiles: [
      {
        content: "Button Button Button",
        name: "Multi.tsx",
        path: "Multi.tsx",
      },
    ],
    instances: [],
    query: "Button",
  });

  assert.equal(matches[0].matchCount, 3);
});

test("finds canvas instances by insertURL or componentName", async () => {
  const { findComponentUsages } = await modulePromise;

  const matches = findComponentUsages({
    codeFiles: [],
    instances: [
      {
        componentName: "Hero Button",
        id: "n1",
        insertURL: "https://framer.com/m/Button-0rIM19.js",
      },
      {
        componentName: "Nav Bar",
        id: "n2",
        insertURL: "https://framer.com/m/NavBar.js",
      },
    ],
    query: "button",
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "canvas-instance");
  assert.equal(matches[0].nodeId, "n1");
});

test("extractMatchedTokens distinguishes similarly-named identifiers", async () => {
  const { extractMatchedTokens } = await modulePromise;

  const content =
    'import Button_1 from "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE"\n' +
    'import Button from "https://framer.com/m/Button-0rIM19.js"';

  const tokens = extractMatchedTokens(content, "Button");

  assert.deepEqual(tokens, [
    "Button",
    "Button_1",
    "Button-0rIM19.js",
    "Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE",
  ]);
});

test("extractMatchedTokens dedupes repeated identical tokens", async () => {
  const { extractMatchedTokens } = await modulePromise;

  const tokens = extractMatchedTokens("Button_1 and Button_1 again", "Button");

  assert.deepEqual(tokens, ["Button_1"]);
});

test("findComponentUsages reports matchedTokens per code file", async () => {
  const { findComponentUsages } = await modulePromise;

  const matches = findComponentUsages({
    codeFiles: [
      {
        content:
          'import Button_1 from "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE"',
        name: "Wrapper.tsx",
        path: "Wrapper.tsx",
      },
    ],
    instances: [],
    query: "Button_1",
  });

  // The URL uses a hyphen ("Button-1-...") not an underscore, so searching
  // "Button_1" only matches the bare local import name, not the URL —
  // exactly the distinction that lets you tell them apart.
  assert.deepEqual(matches[0].matchedTokens, ["Button_1"]);
});

test("returns nothing for an empty query", async () => {
  const { findComponentUsages } = await modulePromise;

  const matches = findComponentUsages({
    codeFiles: [{ content: "Button", name: "A.tsx", path: "A.tsx" }],
    instances: [{ componentName: "Button", id: "n1", insertURL: null }],
    query: "   ",
  });

  assert.equal(matches.length, 0);
});

test("parseChecklistItems recovers cleanly from missing or invalid data", async () => {
  const { parseChecklistItems } = await modulePromise;

  assert.deepEqual(parseChecklistItems(null), []);
  assert.deepEqual(parseChecklistItems("not json"), []);
  assert.deepEqual(parseChecklistItems("[1,2,3]"), []);
  assert.deepEqual(parseChecklistItems('[{"id":"x"}]'), []);
});

test("mergeUsageMatchesIntoChecklist adds only new items, preserving done state", async () => {
  const { mergeUsageMatchesIntoChecklist } = await modulePromise;

  const existing = [
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      detail: "already tracked",
      done: true,
      id: "codefile:FeatureSlider.tsx",
      kind: "code-file",
      label: "FeatureSlider.tsx",
      path: "FeatureSlider.tsx",
    },
  ];

  const matches = [
    {
      id: "codefile:FeatureSlider.tsx",
      kind: "code-file",
      matchCount: 2,
      matchedTokens: ["Button"],
      name: "FeatureSlider.tsx",
      path: "FeatureSlider.tsx",
    },
    {
      id: "codefile:ShapeCard.tsx",
      kind: "code-file",
      matchCount: 1,
      matchedTokens: ["Button"],
      name: "ShapeCard.tsx",
      path: "ShapeCard.tsx",
    },
  ];

  const merged = mergeUsageMatchesIntoChecklist(existing, matches, "Button");

  assert.equal(merged.length, 2);
  assert.equal(merged[0].done, true, "existing item's done state must survive");
  assert.equal(merged[1].id, "codefile:ShapeCard.tsx");
  assert.equal(merged[1].done, false);
});

test("addCustomChecklistItem trims and ignores blank labels", async () => {
  const { addCustomChecklistItem } = await modulePromise;

  const withItem = addCustomChecklistItem([], "  Delete OldButton.tsx  ");
  assert.equal(withItem.length, 1);
  assert.equal(withItem[0].label, "Delete OldButton.tsx");
  assert.equal(withItem[0].kind, "custom");

  const unchanged = addCustomChecklistItem(withItem, "   ");
  assert.equal(unchanged.length, 1);
});

test("toggleChecklistItem flips only the matching item", async () => {
  const { toggleChecklistItem } = await modulePromise;

  const items = [
    { done: false, id: "a" },
    { done: false, id: "b" },
  ];

  const toggled = toggleChecklistItem(items, "a");
  assert.equal(toggled.find((item) => item.id === "a").done, true);
  assert.equal(toggled.find((item) => item.id === "b").done, false);
});

test("removeChecklistItem drops only the matching item", async () => {
  const { removeChecklistItem } = await modulePromise;

  const items = [{ id: "a" }, { id: "b" }];
  const remaining = removeChecklistItem(items, "a");
  assert.deepEqual(remaining, [{ id: "b" }]);
});

test("setChecklistItemDone sets only the matching item, regardless of current state", async () => {
  const { setChecklistItemDone } = await modulePromise;

  const items = [
    { done: false, id: "a" },
    { done: true, id: "b" },
  ];

  const next = setChecklistItemDone(items, "a", true);
  assert.equal(next.find((item) => item.id === "a").done, true);
  assert.equal(next.find((item) => item.id === "b").done, true);
});

test("replaceInCodeFileContent does a literal, case-sensitive swap without needing regex escaping", async () => {
  const { replaceInCodeFileContent } = await modulePromise;

  const content =
    'import Button_1 from "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE"';

  const result = replaceInCodeFileContent(
    content,
    "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE",
    "https://framer.com/m/Button-0rIM19.js"
  );

  assert.equal(result.replacedCount, 1);
  assert.equal(
    result.content,
    'import Button_1 from "https://framer.com/m/Button-0rIM19.js"'
  );
});

test("replaceInCodeFileContent counts every occurrence and leaves content untouched when nothing matches", async () => {
  const { replaceInCodeFileContent } = await modulePromise;

  const multi = replaceInCodeFileContent("Old Old Old", "Old", "New");
  assert.equal(multi.replacedCount, 3);
  assert.equal(multi.content, "New New New");

  const none = replaceInCodeFileContent("Nothing here", "Old", "New");
  assert.equal(none.replacedCount, 0);
  assert.equal(none.content, "Nothing here");
});

test("replaceInCodeFileContent is a no-op for a blank find value", async () => {
  const { replaceInCodeFileContent } = await modulePromise;

  const result = replaceInCodeFileContent("some content", "   ", "New");
  assert.equal(result.replacedCount, 0);
  assert.equal(result.content, "some content");
});

test("previewCodeFileReplacement reports a count and a before/after snippet without changing anything", async () => {
  const { previewCodeFileReplacement } = await modulePromise;

  const content =
    'import Button_1 from "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE"';

  const preview = previewCodeFileReplacement(
    content,
    "https://framer.com/m/Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE",
    "https://framer.com/m/Button-0rIM19.js"
  );

  assert.equal(preview.replacedCount, 1);
  assert.equal(preview.truncated, false);
  assert.equal(preview.snippets.length, 1);
  assert.match(
    preview.snippets[0].before,
    /Button-1-j33J92\.js@J3U5oS6GYQyy5mEj3RgE/u
  );
  assert.match(preview.snippets[0].after, /Button-0rIM19\.js/u);
  assert.doesNotMatch(preview.snippets[0].after, /Button-1-j33J92/u);
});

test("previewCodeFileReplacement caps snippets and reports truncated for many occurrences", async () => {
  const { previewCodeFileReplacement } = await modulePromise;

  const content = Array.from({ length: 8 }, () => "Old").join(" filler ");
  const preview = previewCodeFileReplacement(content, "Old", "New");

  assert.equal(preview.replacedCount, 8);
  assert.equal(preview.snippets.length, 5);
  assert.equal(preview.truncated, true);
});

test("previewCodeFileReplacement returns nothing for a blank find or no match", async () => {
  const { previewCodeFileReplacement } = await modulePromise;

  const blank = previewCodeFileReplacement("some content", "   ", "New");
  assert.equal(blank.replacedCount, 0);
  assert.deepEqual(blank.snippets, []);

  const noMatch = previewCodeFileReplacement("Nothing here", "Old", "New");
  assert.equal(noMatch.replacedCount, 0);
  assert.deepEqual(noMatch.snippets, []);
});
