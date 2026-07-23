import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

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

const modulePromise = loadModule("src/lib/alt-text.ts");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("prefers an SEO title field, then a standard title field", async () => {
  const { findPreferredSeoTitleFieldId } = await modulePromise;

  assert.equal(
    findPreferredSeoTitleFieldId([
      { id: "name", name: "Name" },
      { id: "title", name: "Title" },
      { id: "seo", name: "SEO Title" },
    ]),
    "seo"
  );
  assert.equal(
    findPreferredSeoTitleFieldId([
      { id: "name", name: "Name" },
      { id: "title", name: "Title" },
    ]),
    "title"
  );
});

test("scans missing CMS image alt text with SEO-title proposals", async () => {
  const { collectAltTextCandidates } = await modulePromise;
  const image = {
    altText: undefined,
    thumbnailUrl: "https://example.com/thumb.jpg",
    url: "https://example.com/image.jpg",
  };
  const item = {
    fieldData: {
      hero: { type: "image", value: image },
      seo: { type: "string", value: "Solar installation in Austin" },
    },
    id: "item-1",
    slug: "solar-installation",
  };
  const collection = {
    getFields: () =>
      Promise.resolve([
        { id: "hero", name: "Hero Image", type: "image" },
        { id: "seo", name: "SEO Title", type: "string" },
      ]),
    getItems: () => Promise.resolve([item]),
  };

  const candidates = await collectAltTextCandidates(
    collection,
    "all",
    "seo",
    false
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].altText, "Solar installation in Austin");
  assert.equal(candidates[0].image, image);
});

test("skips existing alt text unless overwrite is enabled", async () => {
  const { collectAltTextCandidates } = await modulePromise;
  const collection = {
    getFields: () =>
      Promise.resolve([
        { id: "image", name: "Image", type: "image" },
        { id: "title", name: "Title", type: "string" },
      ]),
    getItems: () =>
      Promise.resolve([
        {
          fieldData: {
            image: {
              type: "image",
              value: {
                altText: "Existing description",
                url: "https://example.com/image.jpg",
              },
            },
            title: { type: "string", value: "Title" },
          },
          id: "item",
          slug: "item",
        },
      ]),
  };

  const withoutExisting = await collectAltTextCandidates(
    collection,
    "all",
    "title",
    false
  );
  const withExisting = await collectAltTextCandidates(
    collection,
    "all",
    "title",
    true
  );
  assert.equal(withoutExisting.length, 0);
  assert.equal(withExisting.length, 1);
});

test("scans canvas image layers and uses layer names as context", async () => {
  const { collectCanvasAltTextCandidates } = await modulePromise;
  const image = {
    altText: undefined,
    thumbnailUrl: "https://example.com/thumb.jpg",
    url: "https://example.com/hero.jpg",
  };

  const candidates = collectCanvasAltTextCandidates(
    [
      {
        backgroundImage: image,
        id: "canvas-1",
        name: "Austin skyline at sunset",
      },
    ],
    false
  );
  const [candidate] = candidates;

  assert.equal(candidates.length, 1);
  assert.equal(candidate.source, "canvas");
  assert.equal(candidate.altText, "Austin skyline at sunset");
  assert.equal(candidate.image, image);
});

test("skips canvas images with alt text unless overwrite is enabled", async () => {
  const { collectCanvasAltTextCandidates } = await modulePromise;
  const nodes = [
    {
      backgroundImage: {
        altText: "Existing canvas description",
        url: "https://example.com/hero.jpg",
      },
      id: "canvas-1",
      name: "Hero",
    },
  ];

  assert.equal(collectCanvasAltTextCandidates(nodes, false).length, 0);
  assert.equal(collectCanvasAltTextCandidates(nodes, true).length, 1);
});

test("deduplicates component replicas and prefers the source image layer", async () => {
  const { collectCanvasAltTextCandidates } = await modulePromise;
  const image = {
    altText: undefined,
    url: "https://example.com/component-image.jpg",
  };
  const replica = {
    backgroundImage: image,
    id: "replica",
    isReplica: true,
    name: "Component image",
    originalId: "source",
  };
  const source = {
    backgroundImage: image,
    id: "source",
    isReplica: false,
    name: "Component image",
    originalId: null,
  };

  const candidates = collectCanvasAltTextCandidates([replica, source], false);
  const [candidate] = candidates;

  assert.equal(candidates.length, 1);
  assert.equal(candidate.node, source);
  assert.equal(candidate.id, "canvas:source");
});

test("generates clean alt text through the Anthropic vision endpoint", async () => {
  const { generateAltTextWithClaude } = await modulePromise;
  let request;
  globalThis.fetch = (url, options) => {
    request = { options, url };
    return Promise.resolve(
      Response.json({
        content: [
          {
            text: '"Technician installing rooftop solar panels"',
            type: "text",
          },
        ],
      })
    );
  };

  const altText = await generateAltTextWithClaude({
    apiKey: "test-key",
    candidate: {
      image: { url: "https://example.com/solar.jpg" },
      seoTitle: "Austin solar installation",
    },
  });

  assert.equal(altText, "Technician installing rooftop solar panels");
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(
    request.options.headers["anthropic-dangerous-direct-browser-access"],
    "true"
  );
  assert.equal(request.options.headers["x-api-key"], "test-key");
});

test("writes alt text while preserving the CMS image URL", async () => {
  const { applyCandidateAltText } = await modulePromise;
  let update;
  const candidate = {
    altText: "A completed rooftop solar array",
    fieldId: "hero",
    image: { url: "https://example.com/solar.jpg" },
    item: {
      setAttributes: (value) => {
        update = value;
        return Promise.resolve();
      },
    },
  };

  await applyCandidateAltText(candidate);

  assert.deepEqual(update, {
    fieldData: {
      hero: {
        alt: "A completed rooftop solar array",
        type: "image",
        value: "https://example.com/solar.jpg",
      },
    },
  });
});

test("writes canvas alt text by cloning the existing image asset", async () => {
  const { applyCandidateAltText } = await modulePromise;
  let clonedWith;
  let update;
  const clonedImage = { id: "cloned-image" };
  const candidate = {
    altText: "Austin skyline illuminated at dusk",
    image: {
      cloneWithAttributes: (attributes) => {
        clonedWith = attributes;
        return clonedImage;
      },
    },
    node: {
      setAttributes: (attributes) => {
        update = attributes;
        return Promise.resolve();
      },
    },
    source: "canvas",
  };

  await applyCandidateAltText(candidate);

  assert.deepEqual(clonedWith, {
    altText: "Austin skyline illuminated at dusk",
  });
  assert.deepEqual(update, { backgroundImage: clonedImage });
});
