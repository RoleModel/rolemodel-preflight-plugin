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

const modulePromise = loadModule("src/lib/schema-cms.ts");

const MAPPING = {
  bodyFieldId: "body",
  collectionId: "c1",
  collectionName: "Case Studies",
  datePublishedFieldId: "date",
  descriptionFieldId: "desc",
  imageFieldId: "img",
  kind: "caseStudy",
  outputFieldId: "schema",
  pathPrefix: "/case-studies",
  titleFieldId: "title",
};

const ITEM = {
  fieldData: {
    body: {
      type: "formattedText",
      value:
        "<h2>The Challenge</h2><p>Quoting took <strong>4+ hours</strong> &amp; needed a draftsperson.</p>",
    },
    date: { type: "date", value: "2024-03-01" },
    desc: { type: "string", value: "  A configurator for fall protection.  " },
    img: {
      type: "image",
      value: { url: "https://framerusercontent.com/x.png" },
    },
    title: { type: "string", value: "Kattsafe" },
  },
  slug: "kattsafe",
};

test("strips tags and decodes entities from rich text", async () => {
  const { htmlToPlainText } = await modulePromise;

  assert.equal(
    htmlToPlainText("<h2>Hi</h2><p>A &amp; B &lt;ok&gt;</p>"),
    "Hi A & B <ok>"
  );
});

test("builds page content from a CMS item", async () => {
  const { buildPageContentFromCmsItem } = await modulePromise;

  const content = buildPageContentFromCmsItem({ item: ITEM, mapping: MAPPING });

  assert.equal(content.path, "/case-studies/kattsafe");
  assert.equal(content.title, "Kattsafe");
  assert.equal(content.description, "A configurator for fall protection.");
  assert.equal(content.datePublished, "2024-03-01");
  assert.equal(content.imageUrl, "https://framerusercontent.com/x.png");
  assert.equal(
    content.bodyText,
    "The Challenge Quoting took 4+ hours & needed a draftsperson."
  );
  assert.equal(content.source, "cms");
});

test("falls back to the slug when the title field is empty", async () => {
  const { buildPageContentFromCmsItem } = await modulePromise;

  const content = buildPageContentFromCmsItem({
    item: { fieldData: {}, slug: "ez-dock" },
    mapping: MAPPING,
  });

  assert.equal(content.title, "ez-dock");
  assert.equal(content.description, undefined);
  assert.equal(content.imageUrl, undefined);
});

test("joins the path prefix and slug without doubling slashes", async () => {
  const { itemPath } = await modulePromise;

  assert.equal(itemPath("/blog", "post"), "/blog/post");
  assert.equal(itemPath("/blog/", "post"), "/blog/post");
});

test("reports what is still unmapped", async () => {
  const { checkMappingReadiness } = await modulePromise;

  assert.deepEqual(checkMappingReadiness(MAPPING), {
    conflicts: [],
    missing: [],
    ready: true,
  });
  assert.deepEqual(
    checkMappingReadiness({
      ...MAPPING,
      outputFieldId: "",
      pathPrefix: "  ",
      titleFieldId: "",
    }),
    {
      conflicts: [],
      missing: ["path prefix", "title field", "schema output field"],
      ready: false,
    }
  );
});

test("ignores a field whose stored type does not match", async () => {
  const { imageFieldUrl, stringFieldValue } = await modulePromise;
  const item = {
    fieldData: {
      a: { type: "number", value: 12 },
      b: { type: "string", value: "ok" },
    },
    slug: "x",
  };

  assert.equal(stringFieldValue(item, "a"), "");
  assert.equal(stringFieldValue(item, "b"), "ok");
  assert.equal(imageFieldUrl(item, "b"), "");
  assert.equal(stringFieldValue(item, ""), "");
});

test("reads a description stored as rich text, not plain text", async () => {
  const { buildPageContentFromCmsItem } = await modulePromise;

  const content = buildPageContentFromCmsItem({
    item: {
      fieldData: {
        desc: {
          type: "formattedText",
          value: "<p>How we <em>actually</em> collaborate with AI.</p>",
        },
        title: { type: "string", value: "AI Tools" },
      },
      slug: "ai-tools",
    },
    mapping: { ...MAPPING, pathPrefix: "/collaborating-with-ai-guides" },
  });

  assert.equal(content.description, "How we actually collaborate with AI.");
  assert.equal(content.path, "/collaborating-with-ai-guides/ai-tools");
});

test("refuses to write the schema into a field it reads from", async () => {
  const { checkMappingReadiness, findOutputFieldConflicts } =
    await modulePromise;

  // Pointing the output at the Title field would overwrite every title.
  const dangerous = { ...MAPPING, outputFieldId: MAPPING.titleFieldId };

  assert.deepEqual(findOutputFieldConflicts(dangerous), ["title"]);
  assert.equal(checkMappingReadiness(dangerous).ready, false);
  assert.deepEqual(checkMappingReadiness(dangerous).conflicts, ["title"]);
});

test("reports every role the output field collides with", async () => {
  const { findOutputFieldConflicts } = await modulePromise;

  const dangerous = {
    ...MAPPING,
    descriptionFieldId: "shared",
    outputFieldId: "shared",
    titleFieldId: "shared",
  };

  assert.deepEqual(findOutputFieldConflicts(dangerous).toSorted(), [
    "description",
    "title",
  ]);
});

test("an unset output field is not a conflict", async () => {
  const { findOutputFieldConflicts } = await modulePromise;

  assert.deepEqual(
    findOutputFieldConflicts({ ...MAPPING, outputFieldId: "" }),
    []
  );
});
