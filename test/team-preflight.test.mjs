import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "esbuild";

const loadModule = async () => {
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
};

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

test("runTeamPreflight treats links matching a dynamic page path template as valid", async () => {
  const { runTeamPreflight } = await modulePromise;

  const report = await runTeamPreflight(
    {
      contrastPairs: [],
      dynamicPagePaths: ["/blog/:slug", "/collaborating-with-ai/:slug"],
      links: [
        { source: "Article link", value: "/blog/my-first-post" },
        {
          source: "Guide link",
          value: "/collaborating-with-ai/ai-workspace",
        },
        { source: "Base collection page", value: "/blog" },
        { source: "Unrelated missing page", value: "/blog-archive" },
        // A dynamic segment must fill exactly one path part.
        { source: "Too many segments", value: "/blog/a/b" },
      ],
      pagePaths: ["/", "/blog", "/collaborating-with-ai"],
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
  assert.ok(
    report.linkIssues.some(
      (issue) =>
        issue.reason === "Internal page path /blog-archive was not found."
    )
  );
  assert.ok(
    report.linkIssues.some(
      (issue) => issue.reason === "Internal page path /blog/a/b was not found."
    )
  );
});

test("extractWebPageLink reads Framer page-id links", async () => {
  const { extractWebPageLink } = await modulePromise;

  assert.deepEqual(
    extractWebPageLink({ type: "webPage", webPageId: "page-1" }),
    { collectionItemId: undefined, webPageId: "page-1" }
  );
  assert.deepEqual(
    extractWebPageLink({
      collectionItemId: "item-1",
      type: "webPage",
      webPageId: "page-1",
    }),
    { collectionItemId: "item-1", webPageId: "page-1" }
  );
  assert.equal(extractWebPageLink({ type: "url", url: "/x" }), null);
  assert.equal(extractWebPageLink("/x"), null);
});

test("runTeamPreflight flags links to deleted pages and CMS items", async () => {
  const { runTeamPreflight } = await modulePromise;

  const report = await runTeamPreflight(
    {
      collectionItemIds: ["item-live"],
      contrastPairs: [],
      links: [
        {
          source: "Nav link",
          value: { type: "webPage", webPageId: "page-live" },
        },
        {
          source: "Footer link",
          value: { type: "webPage", webPageId: "page-deleted" },
        },
        {
          source: "Blog card",
          value: {
            collectionItemId: "item-deleted",
            type: "webPage",
            webPageId: "page-live",
          },
        },
      ],
      pagePaths: ["/"],
      texts: [],
      webPageIds: ["page-live"],
    },
    {
      checkColorContrast: false,
      checkExternalLinks: false,
      checkPunctuation: false,
      checkSpelling: false,
    }
  );

  assert.equal(report.linkIssues.length, 2);
  assert.match(report.linkIssues[0].reason, /page no longer exists/u);
  assert.equal(report.linkIssues[0].severity, "error");
  assert.match(report.linkIssues[1].reason, /CMS item no longer exists/u);
});

test("findLinkLikeValues catches link-shaped props regardless of prop name", async () => {
  const { findLinkLikeValues, runTeamPreflight } = await modulePromise;

  const links = findLinkLikeValues(
    {
      // Custom-named props that would never match the key heuristic:
      count: 3,
      emptyTarget: { type: "webPage" },
      externalTarget: { type: "url", url: "/services" },
      plainText: "not a link",
      target: { type: "webPage", webPageId: "page-deleted" },
    },
    "Card (node-1)",
    "node-1"
  );

  assert.equal(links.length, 3);

  const report = await runTeamPreflight(
    {
      contrastPairs: [],
      links,
      pagePaths: ["/services"],
      texts: [],
      webPageIds: ["page-live"],
    },
    {
      checkColorContrast: false,
      checkExternalLinks: false,
      checkPunctuation: false,
      checkSpelling: false,
    }
  );

  assert.equal(report.linkIssues.length, 2);
  assert.ok(
    report.linkIssues.some((issue) =>
      /page no longer exists/u.test(issue.reason)
    )
  );
  assert.ok(
    report.linkIssues.some((issue) => issue.reason === "Empty link value.")
  );
});

test("findLinkLikeValues ignores style props whose name merely contains a link-ish substring", async () => {
  const { findLinkLikeValues } = await modulePromise;

  const links = findLinkLikeValues(
    {
      buttonBackgroundColor: "rgb(255, 0, 0)",
      buttonFontSize: "16",
      buttonLink: "/missing-page",
      buttonPadding: "0px",
      ctaBorderColor: "rgb(0, 0, 0)",
    },
    "ShapeCutoutCard (node-1)",
    "node-1"
  );

  assert.equal(links.length, 1);
  assert.equal(links[0].label, "buttonLink");
  assert.equal(links[0].value, "/missing-page");
});

test("findLinkLikeValues ignores enum/mode strings on a url-named key with no URL structure", async () => {
  const { findLinkLikeValues } = await modulePromise;

  const links = findLinkLikeValues(
    {
      // A "custom" urlSource paired with an actual URL value should still
      // be caught.
      customUrl: "/academy",
      // Enum control selecting a strategy ("canonical" | "current" |
      // "custom"), not a literal URL — should not be treated as a link.
      urlSource: "canonical",
    },
    "ShareButton (node-1)",
    "node-1"
  );

  assert.equal(links.length, 1);
  assert.equal(links[0].label, "customUrl");
  assert.equal(links[0].value, "/academy");
});

test("page-id validation is skipped when ids are not provided", async () => {
  const { runTeamPreflight } = await modulePromise;

  const report = await runTeamPreflight(
    {
      contrastPairs: [],
      links: [
        {
          source: "Nav link",
          value: { type: "webPage", webPageId: "page-anything" },
        },
      ],
      pagePaths: ["/"],
      texts: [],
    },
    {
      checkColorContrast: false,
      checkExternalLinks: false,
      checkPunctuation: false,
      checkSpelling: false,
    }
  );

  assert.equal(report.linkIssues.length, 0);
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

  assert.match(text, /External dead-link checks skipped/u);
  assert.match(text, /Spelling checks skipped/u);
  assert.match(text, /Color contrast checks skipped/u);
});
