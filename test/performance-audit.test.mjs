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

test("project performance scan identifies risky code patterns", async () => {
  const { analyzeCodePerformance } = await loadModule(
    "src/lib/performance-audit.ts"
  );

  const result = analyzeCodePerformance(
    [
      {
        content: `
          import * as THREE from "three"
          const titleAnimation = { initial: { opacity: 0 } }
          const blurTrigger = "load"
          const image = "https://assets.example.com/hero.jpg"
        `,
        path: "Hero.tsx",
      },
    ],
    1300
  );

  assert.deepEqual(
    result.findings.map((finding) => finding.id),
    [
      "hidden-text-Hero.tsx",
      "raster-Hero.tsx",
      "three-Hero.tsx",
      "large-project-tree",
    ]
  );
});

test("PageSpeed audit maps mobile metrics and recommendations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (request) => {
    const requestUrl = String(request);
    assert.match(requestUrl, /strategy=mobile/);
    assert.match(requestUrl, /category=performance/);
    return Promise.resolve(
      Response.json({
        lighthouseResult: {
          audits: {
            "cumulative-layout-shift": { displayValue: "0" },
            "first-contentful-paint": { displayValue: "2.1 s" },
            "largest-contentful-paint": {
              displayValue: "8.2 s",
              score: 0.1,
              title: "Largest Contentful Paint",
            },
            "total-blocking-time": { displayValue: "90 ms" },
            "total-byte-weight": { displayValue: "4,500 KiB" },
          },
          categories: { performance: { score: 0.56 } },
        },
      })
    );
  };

  try {
    const { runPageSpeedAudit } = await loadModule(
      "src/lib/performance-audit.ts"
    );
    const result = await runPageSpeedAudit("https://example.com/");

    assert.equal(result.metrics.performanceScore, 56);
    assert.equal(result.metrics.lcp, "8.2 s");
    assert.equal(result.findings[0].id, "pagespeed-largest-contentful-paint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
