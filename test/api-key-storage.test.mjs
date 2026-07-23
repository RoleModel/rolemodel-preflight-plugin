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

const modulePromise = loadModule("src/lib/api-key-storage.ts");

const createStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

test("saves, restores, and clears an Anthropic API key", async () => {
  const {
    clearStoredAnthropicApiKey,
    readStoredAnthropicApiKey,
    saveAnthropicApiKey,
  } = await modulePromise;
  const storage = createStorage();

  assert.equal(saveAnthropicApiKey("sk-ant-test", storage), true);
  assert.equal(readStoredAnthropicApiKey(storage), "sk-ant-test");
  assert.equal(clearStoredAnthropicApiKey(storage), true);
  assert.equal(readStoredAnthropicApiKey(storage), "");
});

test("fails safely when browser storage is unavailable", async () => {
  const {
    clearStoredAnthropicApiKey,
    readStoredAnthropicApiKey,
    saveAnthropicApiKey,
  } = await modulePromise;

  assert.equal(readStoredAnthropicApiKey(null), "");
  assert.equal(saveAnthropicApiKey("sk-ant-test", null), false);
  assert.equal(clearStoredAnthropicApiKey(null), false);
});
