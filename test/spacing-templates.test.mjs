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

const modulePromise = loadModule("src/lib/spacing-templates.ts");

test("loads multiple valid stored spacing templates", async () => {
  const { defaultSpacingTemplates, parseSpacingTemplates } =
    await modulePromise;
  const templates = [
    defaultSpacingTemplates[0],
    {
      ...defaultSpacingTemplates[0],
      id: "compact",
      name: "Compact",
    },
  ];

  assert.deepEqual(parseSpacingTemplates(JSON.stringify(templates)), templates);
});

test("preserves an intentionally empty saved template list", async () => {
  const { parseSpacingTemplates } = await modulePromise;

  assert.deepEqual(parseSpacingTemplates("[]"), []);
});

test("falls back to the starter template when stored data is invalid", async () => {
  const { defaultSpacingTemplates, parseSpacingTemplates } =
    await modulePromise;

  assert.deepEqual(parseSpacingTemplates("{invalid"), defaultSpacingTemplates);
  assert.deepEqual(
    parseSpacingTemplates(JSON.stringify([{ id: "incomplete" }])),
    defaultSpacingTemplates
  );
});

test("duplicates a template with a new id and independent breakpoints", async () => {
  const { createSpacingTemplate, defaultSpacingTemplates } =
    await modulePromise;
  const [original] = defaultSpacingTemplates;
  const duplicate = createSpacingTemplate(original);
  const [duplicateMobile] = duplicate.breakpoints;
  const [originalMobile] = original.breakpoints;

  assert.notEqual(duplicate.id, original.id);
  assert.equal(duplicate.name, `${original.name} copy`);
  duplicateMobile.gap = 999;
  assert.notEqual(duplicateMobile.gap, originalMobile.gap);
});
