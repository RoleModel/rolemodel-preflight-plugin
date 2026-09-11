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

const modulePromise = loadModule("src/lib/schema-config.ts");

const FIELDS = [
  { id: "f1", name: "Title", type: "string" },
  { id: "f2", name: "SEO Description", type: "string" },
  { id: "f3", name: "Cover Image", type: "image" },
  { id: "f4", name: "Publish Date", type: "date" },
  { id: "f5", name: "Body", type: "formattedText" },
  { id: "f6", name: "Schema JSON", type: "string" },
];

test("guesses each field role from its name and type", async () => {
  const { guessFieldId } = await modulePromise;

  assert.equal(guessFieldId(FIELDS, "title", ["string"]), "f1");
  assert.equal(guessFieldId(FIELDS, "description", ["string"]), "f2");
  assert.equal(guessFieldId(FIELDS, "image", ["image"]), "f3");
  assert.equal(guessFieldId(FIELDS, "date", ["date"]), "f4");
  assert.equal(guessFieldId(FIELDS, "body", ["formattedText"]), "f5");
  assert.equal(guessFieldId(FIELDS, "output", ["string"]), "f6");
});

test("returns an empty id when no field fits the allowed types", async () => {
  const { guessFieldId } = await modulePromise;

  assert.equal(guessFieldId(FIELDS, "image", ["file"]), "");
});

test("prefers an exact name match over a partial one", async () => {
  const { guessFieldId } = await modulePromise;
  const fields = [
    { id: "a", name: "Title Tag Override", type: "string" },
    { id: "b", name: "Title", type: "string" },
  ];

  assert.equal(guessFieldId(fields, "title", ["string"]), "b");
});

test("maps collections to a page kind by path then by name", async () => {
  const { guessCollectionKind } = await modulePromise;

  assert.equal(guessCollectionKind("Anything", "/case-studies"), "caseStudy");
  assert.equal(guessCollectionKind("Anything", "/blog"), "blogPost");
  assert.equal(guessCollectionKind("Case Studies", "/work"), "caseStudy");
  assert.equal(guessCollectionKind("Blog Posts", "/writing"), "blogPost");
  assert.equal(guessCollectionKind("Team", "/team"), "generic");
});

test("stored config merges over defaults without losing new fields", async () => {
  const { DEFAULT_SCHEMA_CONFIG, mergeSchemaConfig } = await modulePromise;

  const merged = mergeSchemaConfig({ organizationName: "Renamed Co" });

  assert.equal(merged.organizationName, "Renamed Co");
  assert.equal(merged.origin, DEFAULT_SCHEMA_CONFIG.origin);
  assert.deepEqual(merged.address, DEFAULT_SCHEMA_CONFIG.address);
});

test("falls back to defaults when stored config is not an object", async () => {
  const { DEFAULT_SCHEMA_CONFIG, mergeSchemaConfig } = await modulePromise;

  assert.deepEqual(mergeSchemaConfig(null), DEFAULT_SCHEMA_CONFIG);
  assert.deepEqual(mergeSchemaConfig("nope"), DEFAULT_SCHEMA_CONFIG);
  assert.deepEqual(mergeSchemaConfig([1, 2]), DEFAULT_SCHEMA_CONFIG);
});

test("config round-trips through a storage stub", async () => {
  const { readStoredSchemaConfig, saveSchemaConfig } = await modulePromise;

  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
  };

  const config = { organizationName: "Stored Co", origin: "https://x.com" };
  assert.equal(saveSchemaConfig(config, storage), true);
  assert.equal(readStoredSchemaConfig(storage).organizationName, "Stored Co");
});
