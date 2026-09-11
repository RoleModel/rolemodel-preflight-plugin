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

const modulePromise = loadModule("src/lib/schema.ts");

const CONFIG = {
  address: {
    addressCountry: "US",
    addressLocality: "Apex",
    addressRegion: "NC",
    postalCode: "27539",
    streetAddress: "2141 E Williams St, Suite 204",
  },
  description:
    "RoleModel Software builds custom software tailored to how a business actually works, in partnership with the people who run it.",
  email: "consult@rolemodelsoftware.com",
  foundingDate: "1997",
  legalName: "RoleModel Software, Inc.",
  logoUrl: "https://framerusercontent.com/images/logo.svg",
  organizationName: "RoleModel Software",
  origin: "https://rolemodelsoftware.com",
  telephone: "+1-919-557-7550",
};

const nodeOfType = (graph, type) =>
  graph["@graph"].find((node) => node["@type"] === type);

test("normalizes paths and builds absolute urls", async () => {
  const { absoluteUrl, normalizePath } = await modulePromise;

  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("blog/"), "/blog");
  assert.equal(normalizePath("//blog//post//"), "/blog//post");
  assert.equal(absoluteUrl("https://x.com/", "/"), "https://x.com/");
  assert.equal(absoluteUrl("https://x.com", "about"), "https://x.com/about");
});

test("rebases a staging url onto the canonical origin", async () => {
  const { rebaseUrl } = await modulePromise;

  assert.equal(
    rebaseUrl(
      "https://rolemodelsoftware.com",
      "https://relaxed-store-637823.framer.app/blog/post"
    ),
    "https://rolemodelsoftware.com/blog/post"
  );
});

test("leaves framer asset urls alone", async () => {
  const { rebaseUrl } = await modulePromise;
  const asset = "https://framerusercontent.com/images/abc.png?width=1200";

  assert.equal(rebaseUrl("https://rolemodelsoftware.com", asset), asset);
});

test("collapses headings repeated across framer breakpoints", async () => {
  const { dedupeHeadings } = await modulePromise;

  assert.deepEqual(
    dedupeHeadings([
      "Who is RoleModel Software?",
      "Who is RoleModel Software?",
      "  Who is RoleModel   Software?  ",
      "Our Approach",
    ]),
    ["Who is RoleModel Software?", "Our Approach"]
  );
});

test("classifies every section of the site", async () => {
  const { classifyPath } = await modulePromise;

  assert.equal(classifyPath("/"), "home");
  assert.equal(classifyPath("/about"), "about");
  assert.equal(classifyPath("/portfolio"), "portfolio");
  assert.equal(classifyPath("/case-studies"), "portfolio");
  assert.equal(classifyPath("/case-studies/kattsafe"), "caseStudy");
  assert.equal(classifyPath("/blog"), "blogIndex");
  assert.equal(classifyPath("/blog/iterative-value"), "blogPost");
  assert.equal(classifyPath("/collaborating-with-ai-guides"), "guideIndex");
  assert.equal(classifyPath("/collaborating-with-ai-guides/ai-tools"), "guide");
  assert.equal(classifyPath("/services"), "serviceIndex");
  assert.equal(classifyPath("/optics"), "product");
  assert.equal(classifyPath("/academy"), "course");
  assert.equal(classifyPath("/consultation"), "contact");
  assert.equal(classifyPath("/privacy-policy"), "legal");
  assert.equal(classifyPath("/something-new"), "generic");
});

test("truncates a long description at a sentence boundary", async () => {
  const { truncateDescription } = await modulePromise;
  const value =
    "Kattsafe needed a configuration tool. Our project automated the estimation workflow and cut quoting time dramatically for the whole team.";

  assert.equal(
    truncateDescription(value, 60),
    "Kattsafe needed a configuration tool."
  );
});

test("builds a case study graph with linked entities", async () => {
  const { buildPageGraph, organizationId, webPageId } = await modulePromise;

  const graph = buildPageGraph(CONFIG, {
    clientName: "Kattsafe",
    datePublished: "2024-03-01",
    description:
      "Kattsafe needed a 2D/3D configuration tool to design fall protection systems without a draftsperson, cutting estimation from four hours to thirty minutes.",
    headings: ["The Challenge", "The Challenge", "The Outcome"],
    imageUrl: "https://framerusercontent.com/images/kattsafe.png",
    path: "/case-studies/kattsafe",
    source: "cms",
    title: "Kattsafe",
  });

  const article = nodeOfType(graph, "Article");
  const webPage = nodeOfType(graph, "WebPage");
  const breadcrumb = nodeOfType(graph, "BreadcrumbList");

  assert.ok(article);
  assert.equal(article.articleSection, "Case Study");
  assert.equal(article.about.name, "Kattsafe");
  assert.deepEqual(article.publisher, {
    "@id": organizationId(CONFIG.origin),
  });
  assert.equal(
    article.url,
    "https://rolemodelsoftware.com/case-studies/kattsafe"
  );
  assert.deepEqual(webPage.mainEntity, {
    "@id": "https://rolemodelsoftware.com/case-studies/kattsafe#primary",
  });
  assert.equal(
    webPage["@id"],
    webPageId(CONFIG.origin, "/case-studies/kattsafe")
  );
  assert.equal(breadcrumb.itemListElement.length, 3);
  assert.equal(breadcrumb.itemListElement[1].name, "Case Studies");
  assert.equal(breadcrumb.itemListElement[2].name, "Kattsafe");
});

test("uses BlogPosting for blog posts and TechArticle for guides", async () => {
  const { buildPageGraph } = await modulePromise;

  const post = buildPageGraph(CONFIG, {
    authorName: "Ken Auer",
    datePublished: "2026-01-15",
    description: "A long enough description to clear the thin-content warning.",
    path: "/blog/iterative-value",
    source: "cms",
    title: "Iterative Value",
  });
  const guide = buildPageGraph(CONFIG, {
    description: "A long enough description to clear the thin-content warning.",
    path: "/collaborating-with-ai-guides/ai-tools",
    source: "cms",
    title: "AI Tools",
  });

  assert.ok(nodeOfType(post, "BlogPosting"));
  assert.equal(nodeOfType(post, "BlogPosting").author.name, "Ken Auer");
  assert.ok(nodeOfType(guide, "TechArticle"));
});

test("index pages carry an ItemList of their children", async () => {
  const { buildPageGraph } = await modulePromise;

  const graph = buildPageGraph(
    CONFIG,
    {
      description: "Every project we have shipped with our partners to date.",
      path: "/portfolio",
      source: "canvas",
      title: "Our Work",
    },
    {
      listItems: [
        { name: "Kattsafe", path: "/case-studies/kattsafe" },
        { name: "EZ Dock", path: "/case-studies/ez-dock" },
      ],
    }
  );

  const list = nodeOfType(graph, "ItemList");
  assert.equal(list.numberOfItems, 2);
  assert.equal(
    list.itemListElement[0].url,
    "https://rolemodelsoftware.com/case-studies/kattsafe"
  );
  assert.equal(nodeOfType(graph, "CollectionPage")["@type"], "CollectionPage");
});

test("home page graph omits a breadcrumb", async () => {
  const { buildPageGraph } = await modulePromise;

  const graph = buildPageGraph(CONFIG, {
    description:
      "Custom software built to fit how your business actually runs.",
    path: "/",
    source: "canvas",
    title: "RoleModel Software",
  });

  assert.equal(nodeOfType(graph, "BreadcrumbList"), undefined);
});

test("site graph links WebSite to Organization", async () => {
  const { buildSiteGraph, organizationId } = await modulePromise;

  const graph = buildSiteGraph(CONFIG);
  const site = nodeOfType(graph, "WebSite");

  assert.deepEqual(site.publisher, { "@id": organizationId(CONFIG.origin) });
  assert.equal(nodeOfType(graph, "Organization").name, "RoleModel Software");
});

test("flags urls that escaped the canonical origin", async () => {
  const { findForeignUrls } = await modulePromise;

  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        logo: "https://framerusercontent.com/images/logo.svg",
        url: "https://relaxed-store-637823.framer.app/",
      },
    ],
  };

  assert.deepEqual(findForeignUrls(graph, CONFIG.origin), [
    "https://relaxed-store-637823.framer.app/",
  ]);
});

test("validation catches bad dates, thin copy and foreign urls", async () => {
  const { validateGraph } = await modulePromise;

  const issues = validateGraph(
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@id": "https://rolemodelsoftware.com/x#webpage",
          "@type": "WebPage",
          datePublished: "March 2024",
          description: "Too short.",
          url: "https://staging.example.com/x",
        },
      ],
    },
    CONFIG
  );

  const messages = issues.map((issue) => issue.message).join(" | ");
  assert.match(messages, /not an ISO 8601 date/u);
  assert.match(messages, /Description is only/u);
  assert.match(messages, /outside the canonical origin/u);
});

test("a generated graph validates clean", async () => {
  const { buildPageGraph, validateGraph } = await modulePromise;

  const graph = buildPageGraph(
    CONFIG,
    {
      datePublished: "2024-03-01",
      description:
        "Kattsafe needed a 2D/3D configuration tool to design fall protection systems without a draftsperson.",
      path: "/case-studies/kattsafe",
      source: "cms",
      title: "Kattsafe",
    },
    { includeSiteEntities: true }
  );

  assert.deepEqual(validateGraph(graph, CONFIG), []);
});

test("escapes a nested closing script tag", async () => {
  const { escapeJsonForScript, renderJsonLdScript } = await modulePromise;

  assert.equal(
    escapeJsonForScript('{"a":"</script><script>alert(1)"}'),
    '{"a":"<\\/script><script>alert(1)"}'
  );

  const rendered = renderJsonLdScript({
    "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage", name: "</script>" }],
  });
  assert.ok(!rendered.slice(0, -10).includes("</script>"));
});

test("truncates at the LAST sentence boundary inside the window", async () => {
  const { truncateDescription } = await modulePromise;
  const value =
    "First sentence here. Second sentence here. Third sentence runs past the limit and keeps going.";

  assert.equal(
    truncateDescription(value, 60),
    "First sentence here. Second sentence here."
  );
});

test("keeps a long multi-sentence case study description intact", async () => {
  const { truncateDescription } = await modulePromise;
  const value =
    "Kattsafe needed a 2D/3D configuration tool to design fall protection systems without a draftsperson. The software automated their paper-based estimation workflow, renders a complete 3D design in the browser, generates parts for their existing ERP, and cut estimation from four-plus hours to roughly 30 minutes.";

  assert.equal(truncateDescription(value), value);
});

test("does not flag sameAs profile urls as origin leaks", async () => {
  const { buildSiteGraph, validateGraph } = await modulePromise;

  const config = {
    ...CONFIG,
    sameAs: [
      "https://www.linkedin.com/company/rolemodel-software",
      "https://clutch.co/profile/rolemodel-software",
    ],
  };

  assert.deepEqual(validateGraph(buildSiteGraph(config), config), []);
});

test("site-wide custom code is a static ld+json script", async () => {
  const { buildSiteWideCustomCode } = await modulePromise;
  const code = buildSiteWideCustomCode(CONFIG);

  assert.match(code, /<script type="application\/ld\+json">/u);
  assert.match(code, /"@type": "Organization"/u);
  assert.ok(!code.includes("document.createElement"));
});

test("injector snippet keys paths and avoids polling", async () => {
  const { buildPathInjectorSnippet, buildPageGraph } = await modulePromise;

  const snippet = buildPathInjectorSnippet([
    {
      graph: buildPageGraph(CONFIG, {
        description:
          "A description long enough to avoid the thin-copy warning.",
        path: "/about/",
        source: "canvas",
        title: "About",
      }),
      path: "/about/",
    },
  ]);

  assert.match(snippet, /"\/about":/u);
  assert.ok(!snippet.includes("setInterval"));
  assert.ok(!snippet.includes("console.log"));
  assert.match(snippet, /popstate/u);
});

test("cms field value is compact single-line json", async () => {
  const { buildCmsFieldValue } = await modulePromise;

  const value = buildCmsFieldValue(CONFIG, {
    description: "A description long enough to avoid the thin-copy warning.",
    path: "/case-studies/ez-dock",
    source: "cms",
    title: "EZ Dock",
  });

  assert.ok(!value.includes("\n"));
  assert.equal(JSON.parse(value)["@context"], "https://schema.org");
});

test("combined snippet is static site graph plus a page injector", async () => {
  const { buildCombinedSiteCustomCode, buildPageGraph } = await modulePromise;

  const page = {
    description: "A description long enough to clear the thin-copy warning.",
    path: "/about",
    source: "canvas",
    title: "About",
  };
  const combined = buildCombinedSiteCustomCode(CONFIG, [
    { graph: buildPageGraph(CONFIG, page), path: "/about" },
  ]);

  // Organization must be in a real ld+json tag that precedes any JS.
  const dataStart = combined.indexOf('<script id="rm-preflight-jsonld-data"');
  const staticPart = combined.slice(0, dataStart);
  assert.match(staticPart, /<script type="application\/ld\+json">/u);
  assert.match(staticPart, /"@type": "Organization"/u);
  assert.ok(!staticPart.includes("document.createElement"));
  assert.match(combined, /"\/about":/u);
});

test("combined snippet omits the injector when there are no pages", async () => {
  const { buildCombinedSiteCustomCode } = await modulePromise;
  const combined = buildCombinedSiteCustomCode(CONFIG, []);

  assert.ok(!combined.includes("popstate"));
});

test("estimates snippet size in kb", async () => {
  const { estimateSnippetKb } = await modulePromise;

  assert.equal(estimateSnippetKb("a".repeat(2048)), 2);
});

test("page graphs ride in a parseable application/json block", async () => {
  const { buildCombinedSiteCustomCode, buildPageGraph } = await modulePromise;

  const page = {
    description: "A description long enough to clear the thin-copy warning.",
    path: "/about",
    source: "canvas",
    title: "About",
  };
  const combined = buildCombinedSiteCustomCode(CONFIG, [
    { graph: buildPageGraph(CONFIG, page), path: "/about" },
  ]);

  const match = combined.match(
    /<script id="rm-preflight-jsonld-data" type="application\/json">(?<payload>[\s\S]*?)<\/script>/u
  );
  assert.ok(match);
  const parsed = JSON.parse(match.groups.payload);
  assert.equal(
    parsed["/about"]["@graph"][0].url,
    "https://rolemodelsoftware.com/about"
  );
});

test("cms template keeps {{Field}} bindings intact", async () => {
  const { buildCmsTemplateGraph } = await modulePromise;

  const graph = buildCmsTemplateGraph(CONFIG, {
    fieldNames: {
      datePublished: "Date",
      description: "Excerpt",
      image: "Cover",
      slug: "Slug",
      title: "Title",
    },
    kind: "caseStudy",
    pathPrefix: "/case-studies",
  });

  const article = graph["@graph"].find((n) => n["@type"] === "Article");
  const webPage = graph["@graph"].find((n) => n["@type"] === "WebPage");

  assert.equal(article.headline, "{{Title}}");
  assert.equal(article.description, "{{Excerpt}}");
  assert.equal(article.datePublished, "{{Date}}");
  // The image must NOT be rebased onto the origin.
  assert.equal(article.image, "{{Cover}}");
  assert.equal(
    webPage.url,
    "https://rolemodelsoftware.com/case-studies/{{Slug}}"
  );
});

test("a template graph validates clean despite placeholders", async () => {
  const { buildCmsTemplateGraph, validateGraph } = await modulePromise;

  const graph = buildCmsTemplateGraph(CONFIG, {
    fieldNames: {
      datePublished: "Date",
      description: "Excerpt",
      image: "Cover",
      slug: "Slug",
      title: "Title",
    },
    kind: "blogPost",
    pathPrefix: "/blog",
  });

  // {{Date}} is not ISO and {{Excerpt}} is short — neither is a real problem.
  assert.deepEqual(validateGraph(graph, CONFIG), []);
});

test("template snippet points at the collection template, not the index", async () => {
  const { buildCmsTemplateSnippet } = await modulePromise;

  const snippet = buildCmsTemplateSnippet(CONFIG, {
    fieldNames: { slug: "Slug", title: "Title" },
    kind: "caseStudy",
    pathPrefix: "/case-studies",
  });

  assert.match(snippet, /COLLECTION PAGE TEMPLATE/u);
  assert.match(snippet, /Not the index page/u);
  assert.match(snippet, /<script type="application\/ld\+json">/u);
  assert.ok(!snippet.includes("document.createElement"));
});

test("reports which template bindings are missing", async () => {
  const { missingTemplateBindings } = await modulePromise;

  assert.deepEqual(
    missingTemplateBindings({ slug: "Slug", title: "Title" }),
    []
  );
  assert.deepEqual(missingTemplateBindings({}), ["title", "slug"]);
});

test("placeholders are recognised, real values are not", async () => {
  const { isTemplatePlaceholder } = await modulePromise;

  assert.equal(isTemplatePlaceholder("{{Title}}"), true);
  assert.equal(isTemplatePlaceholder("  {{Cover Image}}  "), true);
  assert.equal(isTemplatePlaceholder("Kattsafe"), false);
  assert.equal(isTemplatePlaceholder("{{a}} and {{b}}"), false);
});
