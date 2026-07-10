import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "esbuild";

async function loadModule() {
  const result = await build({
    bundle: true,
    entryPoints: ["src/lib/team-preflight.ts"],
    format: "esm",
    platform: "node",
    write: false,
  });

  const source = result.outputFiles[0].text;
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
}

const modulePromise = loadModule();

test("extractHref handles strings and Framer URL link controls", async () => {
  const { extractHref } = await modulePromise;

  assert.equal(extractHref(" /services "), "/services");
  assert.equal(
    extractHref({ type: "url", url: "https://rolemodelsoftware.com" }),
    "https://rolemodelsoftware.com"
  );
  assert.equal(extractHref({ href: "/academy" }), "/academy");
  assert.equal(extractHref({ value: "/careers" }), "/careers");
  assert.equal(extractHref(null), null);
});

test("runTeamPreflight flags missing internal links and placeholders", async () => {
  const { runTeamPreflight } = await modulePromise;

  const report = await runTeamPreflight(
    {
      contrastPairs: [],
      links: [
        { source: "Hero CTA", value: "/services" },
        { source: "Bad CTA", value: "/missing-page" },
        { source: "Empty CTA", value: "#" },
      ],
      pagePaths: ["/", "/services"],
      texts: [],
    },
    {
      checkColorContrast: false,
      checkExternalLinks: false,
      checkPunctuation: false,
      checkSpelling: false,
    }
  );

  assert.equal(report.linkIssues.length, 2);
  assert.equal(
    report.linkIssues[0].reason,
    "Internal page path /missing-page was not found."
  );
  assert.equal(report.linkIssues[1].reason, "Placeholder link.");
});

test("punctuation checks catch copy issues without external services", async () => {
  const { findPunctuationIssues } = await modulePromise;

  const issues = findPunctuationIssues([
    {
      source: "Card copy",
      text: "This  sentence has spacing.And TODO copy!!!",
    },
  ]);

  assert.ok(issues.some((issue) => issue.reason === "Double spaces."));
  assert.ok(
    issues.some(
      (issue) => issue.reason === "Missing space after sentence punctuation."
    )
  );
  assert.ok(issues.some((issue) => issue.reason === "Repeated punctuation."));
  assert.ok(issues.some((issue) => issue.reason === "Placeholder copy."));
});

test("contrast ratio and contrast issues use WCAG AA body threshold", async () => {
  const { contrastRatio, findContrastIssues } = await modulePromise;

  assert.ok((contrastRatio("#000", "#fff") ?? 0) > 20);

  const issues = findContrastIssues([
    {
      background: "#888888",
      foreground: "#777777",
      source: "Muted copy",
    },
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].requiredRatio, 4.5);
});

test("formatTeamPreflightReport clearly names skipped optional checks", async () => {
  const { formatTeamPreflightReport } = await modulePromise;

  const text = formatTeamPreflightReport(
    {
      checkedTextNodes: 0,
      contrastIssues: [],
      externalLinksChecked: 0,
      externalLinksUnverified: 0,
      linkIssues: [],
      punctuationIssues: [],
      spellingIssues: [],
    },
    {
      checkColorContrast: false,
      checkExternalLinks: false,
      checkPunctuation: false,
      checkSpelling: false,
    }
  );

  assert.match(text, /External dead-link checks skipped/);
  assert.match(text, /Spelling checks skipped/);
  assert.match(text, /Color contrast checks skipped/);
});
