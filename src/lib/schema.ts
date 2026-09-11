/**
 * JSON-LD structured data generation.
 *
 * Design notes:
 *  - Everything is emitted as a single `@graph` with stable `@id` values so the
 *    entities cross-reference instead of repeating themselves. That is what makes
 *    the output useful to LLM crawlers: fetch any one page and you can resolve the
 *    whole entity model from it.
 *  - Output is intended to be rendered *statically* into the document head (site
 *    graph via custom code, per-item graph via a CMS field bound into the
 *    collection page template). Runtime injection is a fallback, not the target.
 *  - Every URL is forced back onto the configured origin. The previous generation
 *    of this data shipped with staging URLs baked in, so origin normalization is a
 *    first-class concern here rather than a cleanup step.
 */

const SCHEMA_CONTEXT = "https://schema.org";
const PATH_SEPARATOR = "/";
const MAX_DESCRIPTION_LENGTH = 500;
const MIN_DESCRIPTION_LENGTH = 50;
const MAX_KEYWORDS = 12;
const MIN_SENTENCE_FILL = 0.4;
const WORDS_PER_MINUTE = 220;

const TRAILING_SLASH_PATTERN = /\/+$/u;
const LEADING_SLASH_PATTERN = /^\/+/u;
const WHITESPACE_PATTERN = /\s+/gu;
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCRIPT_CLOSE_PATTERN = /<\/script/giu;
const LINE_SEPARATOR_PATTERN = /\u2028/gu;
const PARAGRAPH_SEPARATOR_PATTERN = /\u2029/gu;
const SLUG_WORD_SEPARATOR_PATTERN = /[-_]+/gu;
const SENTENCE_END_PATTERN_GLOBAL = /[.!?](?=\s|$)/gu;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/u;
/** Framer CMS variable binding, e.g. {{Title}}, used in page custom code. */
const TEMPLATE_PLACEHOLDER_PATTERN = /^\{\{[^{}]+\}\}$/u;

/**
 * A value that Framer will substitute per CMS item at render time. These must
 * survive the pipeline untouched — not rebased onto the origin, not truncated,
 * not validated as a date.
 */
export const isTemplatePlaceholder = (value: string): boolean =>
  TEMPLATE_PLACEHOLDER_PATTERN.test(value.trim());

export const templateBinding = (fieldName: string): string =>
  `{{${fieldName}}}`;

/** Page archetypes we know how to describe. */
export type PageKind =
  | "about"
  | "approach"
  | "blogIndex"
  | "blogPost"
  | "careers"
  | "caseStudy"
  | "contact"
  | "course"
  | "generic"
  | "guide"
  | "guideIndex"
  | "home"
  | "legal"
  | "portfolio"
  | "product"
  | "service"
  | "serviceIndex";

export interface PostalAddressConfig {
  addressCountry: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  streetAddress: string;
}

export interface SchemaSiteConfig {
  /** Canonical origin, no trailing slash. Every emitted URL is rebased onto this. */
  origin: string;
  organizationName: string;
  legalName?: string;
  logoUrl?: string;
  description: string;
  foundingDate?: string;
  numberOfEmployees?: number;
  email?: string;
  telephone?: string;
  address?: PostalAddressConfig;
  /** Profile/citation URLs that corroborate the entity (LinkedIn, Clutch, etc). */
  sameAs?: string[];
  /** Topics the organization is an authority on — read directly by answer engines. */
  knowsAbout?: string[];
  areaServed?: string[];
  searchPath?: string;
}

export interface PageContent {
  path: string;
  title: string;
  description?: string;
  /** Heading text in document order. Framer repeats headings per breakpoint. */
  headings?: string[];
  bodyText?: string;
  imageUrl?: string;
  datePublished?: string;
  dateModified?: string;
  authorName?: string;
  keywords?: string[];
  /** Case studies: who the work was for. */
  clientName?: string;
  source: "canvas" | "cms";
  collectionName?: string;
}

export type JsonLdValue =
  | JsonLdValue[]
  | boolean
  | number
  | string
  | { [key: string]: JsonLdValue | undefined };

export type JsonLdNode = Record<string, JsonLdValue | undefined>;

export interface SchemaGraph {
  "@context": string;
  "@graph": JsonLdNode[];
}

export type SchemaIssueSeverity = "error" | "warning";

export interface SchemaIssue {
  severity: SchemaIssueSeverity;
  message: string;
  path?: string;
}

/* ------------------------------------------------------------------ *
 * URL + text helpers
 * ------------------------------------------------------------------ */

export const normalizeOrigin = (origin: string): string =>
  origin.trim().replace(TRAILING_SLASH_PATTERN, "");

export const normalizePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed === PATH_SEPARATOR) {
    return PATH_SEPARATOR;
  }
  const withoutLeading = trimmed.replace(LEADING_SLASH_PATTERN, "");
  const withoutTrailing = withoutLeading.replace(TRAILING_SLASH_PATTERN, "");
  return `${PATH_SEPARATOR}${withoutTrailing}`;
};

export const pathSegments = (path: string): string[] =>
  normalizePath(path).split(PATH_SEPARATOR).filter(Boolean);

export const absoluteUrl = (origin: string, path: string): string => {
  const base = normalizeOrigin(origin);
  const normalized = normalizePath(path);
  return normalized === PATH_SEPARATOR ? `${base}/` : `${base}${normalized}`;
};

/**
 * Rebase an asset or page URL onto the canonical origin.
 *
 * Framer user-content URLs (images, fonts) live on their own CDN and are left
 * alone; anything pointing at a site-like origin is rewritten so a staging
 * domain can never leak into published structured data.
 */
export const rebaseUrl = (
  origin: string,
  url: string | undefined,
  externalHostAllowList: readonly string[] = ["framerusercontent.com"]
): string | undefined => {
  if (!url) {
    return;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return;
  }
  if (isTemplatePlaceholder(trimmed)) {
    return trimmed;
  }
  if (!ABSOLUTE_URL_PATTERN.test(trimmed)) {
    return absoluteUrl(origin, trimmed);
  }
  const allowed = externalHostAllowList.some((host) => trimmed.includes(host));
  if (allowed) {
    return trimmed;
  }
  const base = normalizeOrigin(origin);
  if (trimmed.startsWith(base)) {
    return trimmed;
  }
  const afterScheme = trimmed.replace(ABSOLUTE_URL_PATTERN, "");
  const firstSlash = afterScheme.indexOf(PATH_SEPARATOR);
  const remainder = firstSlash === -1 ? "" : afterScheme.slice(firstSlash);
  return absoluteUrl(origin, remainder);
};

export const collapseWhitespace = (value: string): string =>
  value.replace(WHITESPACE_PATTERN, " ").trim();

/**
 * Framer renders the same heading once per breakpoint, so raw heading lists
 * arrive with two or three identical entries. Collapse them but keep order.
 */
export const dedupeHeadings = (headings: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const heading of headings) {
    const cleaned = collapseWhitespace(heading);
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
  }
  return result;
};

export const titleFromSlug = (slug: string): string =>
  slug
    .replace(SLUG_WORD_SEPARATOR_PATTERN, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");

/** Index of the final sentence-terminating punctuation mark in `value`, or -1. */
const findLastSentenceEnd = (value: string): number => {
  let index = -1;
  for (const match of value.matchAll(SENTENCE_END_PATTERN_GLOBAL)) {
    const { index: matchIndex } = match;
    if (matchIndex !== undefined) {
      index = matchIndex;
    }
  }
  return index;
};

/** Trim to a sentence boundary where possible so descriptions never dangle. */
export const truncateDescription = (
  value: string,
  maxLength: number = MAX_DESCRIPTION_LENGTH
): string => {
  const cleaned = collapseWhitespace(value);
  if (isTemplatePlaceholder(cleaned) || cleaned.length <= maxLength) {
    return cleaned;
  }
  const window = cleaned.slice(0, maxLength);
  const lastSentenceEnd = findLastSentenceEnd(window);
  if (lastSentenceEnd > maxLength * MIN_SENTENCE_FILL) {
    return window.slice(0, lastSentenceEnd + 1).trim();
  }
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) {
    return `${window.slice(0, lastSpace).trim()}…`;
  }
  return `${window.trim()}…`;
};

export const countWords = (value: string): number =>
  collapseWhitespace(value).split(" ").filter(Boolean).length;

export const readingTimeMinutes = (value: string): number =>
  Math.max(1, Math.round(countWords(value) / WORDS_PER_MINUTE));

/* ------------------------------------------------------------------ *
 * Page classification
 * ------------------------------------------------------------------ */

export interface PageKindRule {
  /** First path segment this rule matches, e.g. "case-studies". */
  segment: string;
  /** Kind for the section landing page (/case-studies). */
  indexKind: PageKind;
  /** Kind for a page beneath it (/case-studies/kattsafe). */
  itemKind: PageKind;
  /** Human label used in breadcrumbs. */
  label: string;
}

/**
 * Default section map. Anything unmatched falls back to a plain WebPage, which
 * is always valid — an unknown section degrades, it does not break.
 */
export const DEFAULT_PAGE_KIND_RULES: readonly PageKindRule[] = [
  {
    indexKind: "portfolio",
    itemKind: "caseStudy",
    label: "Case Studies",
    segment: "case-studies",
  },
  {
    indexKind: "blogIndex",
    itemKind: "blogPost",
    label: "Blog",
    segment: "blog",
  },
  {
    indexKind: "guideIndex",
    itemKind: "guide",
    label: "Collaborating With AI",
    segment: "collaborating-with-ai-guides",
  },
  {
    indexKind: "serviceIndex",
    itemKind: "service",
    label: "Services",
    segment: "services",
  },
  {
    indexKind: "course",
    itemKind: "course",
    label: "Academy",
    segment: "academy",
  },
] as const;

const SINGLE_PAGE_KINDS: Readonly<Record<string, PageKind>> = {
  about: "about",
  approach: "approach",
  brand: "generic",
  careers: "careers",
  consultation: "contact",
  optics: "product",
  portfolio: "portfolio",
  "privacy-policy": "legal",
  "rolemodel-way": "about",
  "schedule-a-call": "contact",
};

export const classifyPath = (
  path: string,
  rules: readonly PageKindRule[] = DEFAULT_PAGE_KIND_RULES
): PageKind => {
  const segments = pathSegments(path);
  if (segments.length === 0) {
    return "home";
  }
  const [first] = segments;
  const rule = rules.find((candidate) => candidate.segment === first);
  if (rule) {
    return segments.length > 1 ? rule.itemKind : rule.indexKind;
  }
  return SINGLE_PAGE_KINDS[first] ?? "generic";
};

/* ------------------------------------------------------------------ *
 * Stable @id helpers
 * ------------------------------------------------------------------ */

export const organizationId = (origin: string): string =>
  `${normalizeOrigin(origin)}/#organization`;

export const websiteId = (origin: string): string =>
  `${normalizeOrigin(origin)}/#website`;

export const webPageId = (origin: string, path: string): string =>
  `${absoluteUrl(origin, path)}#webpage`;

export const primaryEntityId = (origin: string, path: string): string =>
  `${absoluteUrl(origin, path)}#primary`;

export const breadcrumbId = (origin: string, path: string): string =>
  `${absoluteUrl(origin, path)}#breadcrumb`;

const reference = (id: string): JsonLdNode => ({ "@id": id });

/** Drop undefined/empty members so the emitted JSON has no dead keys. */
export const compactNode = (node: JsonLdNode): JsonLdNode => {
  const result: JsonLdNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    result[key] = value;
  }
  return result;
};

/* ------------------------------------------------------------------ *
 * Site-level entities
 * ------------------------------------------------------------------ */

export const buildPostalAddress = (address: PostalAddressConfig): JsonLdNode =>
  compactNode({
    "@type": "PostalAddress",
    addressCountry: address.addressCountry,
    addressLocality: address.addressLocality,
    addressRegion: address.addressRegion,
    postalCode: address.postalCode,
    streetAddress: address.streetAddress,
  });

export const buildOrganizationNode = (config: SchemaSiteConfig): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  const contactPoint =
    config.telephone || config.email
      ? compactNode({
          "@type": "ContactPoint",
          contactType: "sales",
          email: config.email,
          telephone: config.telephone,
        })
      : undefined;

  return compactNode({
    "@id": organizationId(origin),
    "@type": "Organization",
    address: config.address ? buildPostalAddress(config.address) : undefined,
    areaServed: config.areaServed,
    contactPoint,
    description: config.description,
    email: config.email,
    foundingDate: config.foundingDate,
    knowsAbout: config.knowsAbout,
    legalName: config.legalName,
    logo: rebaseUrl(origin, config.logoUrl),
    name: config.organizationName,
    numberOfEmployees: config.numberOfEmployees,
    sameAs: config.sameAs,
    telephone: config.telephone,
    url: `${origin}/`,
  });
};

export const buildWebSiteNode = (config: SchemaSiteConfig): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  const searchAction = config.searchPath
    ? {
        "@type": "SearchAction",
        "query-input": "required name=search_term_string",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${origin}${config.searchPath}{search_term_string}`,
        },
      }
    : undefined;

  return compactNode({
    "@id": websiteId(origin),
    "@type": "WebSite",
    description: config.description,
    inLanguage: "en-US",
    name: config.organizationName,
    potentialAction: searchAction,
    publisher: reference(organizationId(origin)),
    url: `${origin}/`,
  });
};

/** The entities every page carries, so a single fetched page resolves the site. */
export const buildSiteGraph = (config: SchemaSiteConfig): SchemaGraph => ({
  "@context": SCHEMA_CONTEXT,
  "@graph": [buildOrganizationNode(config), buildWebSiteNode(config)],
});

/* ------------------------------------------------------------------ *
 * Breadcrumbs
 * ------------------------------------------------------------------ */

const labelForSegment = (
  segment: string,
  rules: readonly PageKindRule[]
): string =>
  rules.find((rule) => rule.segment === segment)?.label ??
  titleFromSlug(segment);

export const buildBreadcrumbNode = (
  config: SchemaSiteConfig,
  page: PageContent,
  rules: readonly PageKindRule[] = DEFAULT_PAGE_KIND_RULES
): JsonLdNode | undefined => {
  const origin = normalizeOrigin(config.origin);
  const segments = pathSegments(page.path);
  if (segments.length === 0) {
    return;
  }

  const items: JsonLdNode[] = [
    {
      "@type": "ListItem",
      item: `${origin}/`,
      name: "Home",
      position: 1,
    },
  ];

  let accumulated = "";
  for (const [index, segment] of segments.entries()) {
    accumulated = `${accumulated}/${segment}`;
    const isLast = index === segments.length - 1;
    const name = isLast
      ? collapseWhitespace(page.title) || labelForSegment(segment, rules)
      : labelForSegment(segment, rules);
    items.push({
      "@type": "ListItem",
      item: absoluteUrl(origin, accumulated),
      name,
      position: index + 2,
    });
  }

  return {
    "@id": breadcrumbId(origin, page.path),
    "@type": "BreadcrumbList",
    itemListElement: items,
  };
};

/* ------------------------------------------------------------------ *
 * Primary entity per page kind
 * ------------------------------------------------------------------ */

const ARTICLE_KINDS: ReadonlySet<PageKind> = new Set<PageKind>([
  "blogPost",
  "caseStudy",
  "guide",
]);

const WEBPAGE_TYPE_BY_KIND: Readonly<Record<PageKind, string>> = {
  about: "AboutPage",
  approach: "WebPage",
  blogIndex: "CollectionPage",
  blogPost: "WebPage",
  careers: "WebPage",
  caseStudy: "WebPage",
  contact: "ContactPage",
  course: "WebPage",
  generic: "WebPage",
  guide: "WebPage",
  guideIndex: "CollectionPage",
  home: "WebPage",
  legal: "WebPage",
  portfolio: "CollectionPage",
  product: "WebPage",
  service: "WebPage",
  serviceIndex: "CollectionPage",
};

const ARTICLE_TYPE_BY_KIND: Readonly<Partial<Record<PageKind, string>>> = {
  blogPost: "BlogPosting",
  caseStudy: "Article",
  guide: "TechArticle",
};

const ARTICLE_SECTION_BY_KIND: Readonly<Partial<Record<PageKind, string>>> = {
  blogPost: "Blog",
  caseStudy: "Case Study",
  guide: "Guide",
};

export const resolveDescription = (page: PageContent): string => {
  if (page.description) {
    return truncateDescription(page.description);
  }
  if (page.bodyText) {
    return truncateDescription(page.bodyText);
  }
  return "";
};

const buildArticleNode = (
  config: SchemaSiteConfig,
  page: PageContent,
  kind: PageKind
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  const headings = dedupeHeadings(page.headings ?? []);
  const url = absoluteUrl(origin, page.path);
  const author = page.authorName
    ? { "@type": "Person", name: page.authorName }
    : reference(organizationId(origin));

  return compactNode({
    "@id": primaryEntityId(origin, page.path),
    "@type": ARTICLE_TYPE_BY_KIND[kind] ?? "Article",
    about:
      kind === "caseStudy" && page.clientName
        ? { "@type": "Organization", name: page.clientName }
        : undefined,
    articleSection: ARTICLE_SECTION_BY_KIND[kind],
    author,
    dateModified: page.dateModified,
    datePublished: page.datePublished,
    description: resolveDescription(page),
    headline: collapseWhitespace(page.title),
    image: rebaseUrl(origin, page.imageUrl),
    inLanguage: "en-US",
    isPartOf: reference(websiteId(origin)),
    keywords: page.keywords?.slice(0, MAX_KEYWORDS),
    mainEntityOfPage: reference(webPageId(origin, page.path)),
    publisher: reference(organizationId(origin)),
    /** Section headings give answer engines the article's actual structure. */
    speakable:
      headings.length > 0
        ? {
            "@type": "SpeakableSpecification",
            cssSelector: ["h1", "h2"],
          }
        : undefined,
    url,
    wordCount: page.bodyText ? countWords(page.bodyText) : undefined,
  });
};

const buildServiceNode = (
  config: SchemaSiteConfig,
  page: PageContent
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  return compactNode({
    "@id": primaryEntityId(origin, page.path),
    "@type": "Service",
    areaServed: config.areaServed,
    description: resolveDescription(page),
    name: collapseWhitespace(page.title),
    provider: reference(organizationId(origin)),
    serviceType: collapseWhitespace(page.title),
    url: absoluteUrl(origin, page.path),
  });
};

const buildProductNode = (
  config: SchemaSiteConfig,
  page: PageContent
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  return compactNode({
    "@id": primaryEntityId(origin, page.path),
    "@type": "SoftwareApplication",
    applicationCategory: "DesignApplication",
    description: resolveDescription(page),
    image: rebaseUrl(origin, page.imageUrl),
    name: collapseWhitespace(page.title),
    publisher: reference(organizationId(origin)),
    url: absoluteUrl(origin, page.path),
  });
};

const buildCourseNode = (
  config: SchemaSiteConfig,
  page: PageContent
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  return compactNode({
    "@id": primaryEntityId(origin, page.path),
    "@type": "Course",
    description: resolveDescription(page),
    name: collapseWhitespace(page.title),
    provider: reference(organizationId(origin)),
    url: absoluteUrl(origin, page.path),
  });
};

/**
 * The entity the page is *about*, distinct from the page itself. Returning
 * undefined is fine — plenty of pages are adequately described by WebPage alone.
 */
export const buildPrimaryEntityNode = (
  config: SchemaSiteConfig,
  page: PageContent,
  kind: PageKind
): JsonLdNode | undefined => {
  if (ARTICLE_KINDS.has(kind)) {
    return buildArticleNode(config, page, kind);
  }
  if (kind === "service") {
    return buildServiceNode(config, page);
  }
  if (kind === "product") {
    return buildProductNode(config, page);
  }
  if (kind === "course") {
    return buildCourseNode(config, page);
  }
  return undefined;
};

/* ------------------------------------------------------------------ *
 * WebPage + full page graph
 * ------------------------------------------------------------------ */

export const buildWebPageNode = (
  config: SchemaSiteConfig,
  page: PageContent,
  kind: PageKind,
  options: { hasBreadcrumb: boolean; primaryEntityId?: string }
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  return compactNode({
    "@id": webPageId(origin, page.path),
    "@type": WEBPAGE_TYPE_BY_KIND[kind],
    breadcrumb: options.hasBreadcrumb
      ? reference(breadcrumbId(origin, page.path))
      : undefined,
    dateModified: page.dateModified,
    datePublished: page.datePublished,
    description: resolveDescription(page),
    inLanguage: "en-US",
    isPartOf: reference(websiteId(origin)),
    mainEntity: options.primaryEntityId
      ? reference(options.primaryEntityId)
      : undefined,
    name: collapseWhitespace(page.title),
    primaryImageOfPage: rebaseUrl(origin, page.imageUrl),
    url: absoluteUrl(origin, page.path),
  });
};

export interface BuildPageGraphOptions {
  /**
   * Include Organization + WebSite in the page's own graph. Leave false when the
   * site graph is already rendered site-wide — the `@id` references still
   * resolve, and the page stays small.
   */
  includeSiteEntities?: boolean;
  kind?: PageKind;
  rules?: readonly PageKindRule[];
  /** Items to list on an index page (portfolio, blog index, guide index). */
  listItems?: readonly { name: string; path: string }[];
}

const buildItemListNode = (
  config: SchemaSiteConfig,
  page: PageContent,
  listItems: readonly { name: string; path: string }[]
): JsonLdNode => {
  const origin = normalizeOrigin(config.origin);
  return {
    "@id": `${absoluteUrl(origin, page.path)}#itemlist`,
    "@type": "ItemList",
    itemListElement: listItems.map((item, index) => ({
      "@type": "ListItem",
      name: collapseWhitespace(item.name),
      position: index + 1,
      url: absoluteUrl(origin, item.path),
    })),
    numberOfItems: listItems.length,
  };
};

export const buildPageGraph = (
  config: SchemaSiteConfig,
  page: PageContent,
  options: BuildPageGraphOptions = {}
): SchemaGraph => {
  const rules = options.rules ?? DEFAULT_PAGE_KIND_RULES;
  const kind = options.kind ?? classifyPath(page.path, rules);
  const origin = normalizeOrigin(config.origin);

  const primary = buildPrimaryEntityNode(config, page, kind);
  const breadcrumb = buildBreadcrumbNode(config, page, rules);
  const webPage = buildWebPageNode(config, page, kind, {
    hasBreadcrumb: Boolean(breadcrumb),
    primaryEntityId: primary ? primaryEntityId(origin, page.path) : undefined,
  });

  const nodes: JsonLdNode[] = [];
  if (options.includeSiteEntities) {
    nodes.push(buildOrganizationNode(config), buildWebSiteNode(config));
  }
  nodes.push(webPage);
  if (breadcrumb) {
    nodes.push(breadcrumb);
  }
  if (primary) {
    nodes.push(primary);
  }
  if (options.listItems && options.listItems.length > 0) {
    nodes.push(buildItemListNode(config, page, options.listItems));
  }

  return { "@context": SCHEMA_CONTEXT, "@graph": nodes };
};

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

const JSON_INDENT = 2;

/**
 * Escape the three sequences that can break a JSON payload out of its own
 * script tag or out of a JS string literal.
 */
export const escapeJsonForScript = (json: string): string =>
  json
    .replace(SCRIPT_CLOSE_PATTERN, "<\\/script")
    .replace(LINE_SEPARATOR_PATTERN, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR_PATTERN, "\\u2029");

export const serializeGraph = (graph: SchemaGraph, pretty = true): string =>
  JSON.stringify(graph, null, pretty ? JSON_INDENT : undefined);

export const renderJsonLdScript = (graph: SchemaGraph, pretty = true): string =>
  `<script type="application/ld+json">\n${escapeJsonForScript(
    serializeGraph(graph, pretty)
  )}\n</script>`;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Keys whose values are *meant* to point off-site. `sameAs` is the whole point
 * of `sameAs` — it corroborates the entity against LinkedIn, Clutch and the
 * like, so origin checking must skip it rather than flag it.
 */
const OFF_ORIGIN_KEYS: ReadonlySet<string> = new Set([
  "identifier",
  "sameAs",
  "subjectOf",
]);

const collectUrls = (value: JsonLdValue | undefined, found: string[]): void => {
  if (typeof value === "string") {
    if (ABSOLUTE_URL_PATTERN.test(value) && !isTemplatePlaceholder(value)) {
      found.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectUrls(entry, found);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (OFF_ORIGIN_KEYS.has(key)) {
        continue;
      }
      collectUrls(entry, found);
    }
  }
};

/**
 * Absolute URLs in the graph that point somewhere other than the canonical
 * origin or an allowed asset host. This is the check that would have caught the
 * staging-domain URLs shipped by the previous generator.
 */
export const findForeignUrls = (
  graph: SchemaGraph,
  origin: string,
  externalHostAllowList: readonly string[] = ["framerusercontent.com"]
): string[] => {
  const base = normalizeOrigin(origin);
  const found: string[] = [];
  collectUrls(graph["@graph"] as unknown as JsonLdValue, found);
  const foreign = found.filter(
    (url) =>
      !url.startsWith(base) &&
      !externalHostAllowList.some((host) => url.includes(host))
  );
  return [...new Set(foreign)];
};

export const validateGraph = (
  graph: SchemaGraph,
  config: SchemaSiteConfig
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  const nodes = graph["@graph"];

  if (nodes.length === 0) {
    issues.push({ message: "Graph is empty.", severity: "error" });
    return issues;
  }

  for (const node of nodes) {
    const type = node["@type"];
    const id = typeof node["@id"] === "string" ? node["@id"] : undefined;
    if (!type) {
      issues.push({
        message: `Node is missing @type${id ? ` (${id})` : ""}.`,
        path: id,
        severity: "error",
      });
    }
    const { description } = node;
    if (
      typeof description === "string" &&
      !isTemplatePlaceholder(description) &&
      description.length < MIN_DESCRIPTION_LENGTH
    ) {
      issues.push({
        message: `Description is only ${description.length} characters — thin descriptions give answer engines little to quote.`,
        path: id,
        severity: "warning",
      });
    }
    for (const dateKey of ["datePublished", "dateModified"]) {
      const value = node[dateKey];
      if (
        typeof value === "string" &&
        !isTemplatePlaceholder(value) &&
        !ISO_DATE_PATTERN.test(value)
      ) {
        issues.push({
          message: `${dateKey} "${value}" is not an ISO 8601 date.`,
          path: id,
          severity: "error",
        });
      }
    }
  }

  for (const url of findForeignUrls(graph, config.origin)) {
    issues.push({
      message: `URL points outside the canonical origin: ${url}`,
      severity: "error",
    });
  }

  const referencedIds = new Set<string>();
  const declaredIds = new Set<string>();
  for (const node of nodes) {
    if (typeof node["@id"] === "string") {
      declaredIds.add(node["@id"]);
    }
  }
  const walkRefs = (value: JsonLdValue | undefined): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walkRefs(entry);
      }
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      const isBareRef = entries.length === 1 && entries[0]?.[0] === "@id";
      if (isBareRef && typeof entries[0][1] === "string") {
        referencedIds.add(entries[0][1] as string);
        return;
      }
      for (const entry of Object.values(value)) {
        walkRefs(entry);
      }
    }
  };
  walkRefs(nodes as unknown as JsonLdValue);

  for (const ref of referencedIds) {
    const isSiteEntity =
      ref === organizationId(config.origin) || ref === websiteId(config.origin);
    if (!declaredIds.has(ref) && !isSiteEntity) {
      issues.push({
        message: `@id reference "${ref}" is not declared in this graph or the site graph.`,
        severity: "warning",
      });
    }
  }

  return issues;
};

/* ------------------------------------------------------------------ *
 * Emitting to the site
 * ------------------------------------------------------------------ */

/**
 * The site-wide snippet: Organization + WebSite, rendered statically into the
 * head of every page by Framer's custom code. Static matters — crawlers that do
 * not execute JavaScript (most LLM crawlers) only ever see this version.
 */
export const buildSiteWideCustomCode = (config: SchemaSiteConfig): string =>
  [
    "<!-- RoleModel Preflight: site-wide structured data. Generated — edit in the plugin, not here. -->",
    renderJsonLdScript(buildSiteGraph(config)),
  ].join("\n");

export interface PathGraphEntry {
  path: string;
  graph: SchemaGraph;
}

const INJECTOR_NOTE = [
  "<!-- RoleModel Preflight: per-path structured data.",
  "     Generated — edit in the plugin, not here.",
  "     Note: this part is applied at runtime, so crawlers that do not execute",
  "     JavaScript see only the site graph above. -->",
].join("\n");

/**
 * Runtime injector for every path in the site.
 *
 * The graph map is emitted as `<script type="application/json">` rather than a
 * JS object literal: the browser skips it during JS parsing entirely and we pay
 * one JSON.parse only on the page actually being viewed. At ~300KB raw this is
 * the difference between data and 300KB of source to parse.
 *
 * Deliberately different from the generator this replaces: no console logging,
 * and no 100ms polling loop — it hooks the History API and `popstate` instead,
 * so it costs nothing between navigations.
 */
export const buildPathInjectorSnippet = (
  entries: readonly PathGraphEntry[]
): string => {
  const map: Record<string, unknown> = {};
  for (const entry of entries) {
    map[normalizePath(entry.path)] = entry.graph;
  }
  const payload = escapeJsonForScript(JSON.stringify(map));

  const script = [
    "(function () {",
    '  "use strict";',
    '  var DATA_ID = "rm-preflight-jsonld-data";',
    '  var MARKER = "data-rm-preflight-jsonld";',
    "  var graphs = null;",
    "  function load() {",
    "    if (graphs) {",
    "      return graphs;",
    "    }",
    "    var node = document.getElementById(DATA_ID);",
    "    try {",
    "      graphs = node ? JSON.parse(node.textContent) : {};",
    "    } catch (error) {",
    "      graphs = {};",
    "    }",
    "    return graphs;",
    "  }",
    "  function render() {",
    "    var existing = document.querySelectorAll('script[' + MARKER + ']');",
    "    for (var i = 0; i < existing.length; i++) {",
    "      existing[i].remove();",
    "    }",
    '    var path = window.location.pathname.replace(/\\/+$/, "") || "/";',
    "    var graph = load()[path];",
    "    if (!graph) {",
    "      return;",
    "    }",
    '    var script = document.createElement("script");',
    '    script.type = "application/ld+json";',
    '    script.setAttribute(MARKER, "true");',
    "    script.textContent = JSON.stringify(graph);",
    "    document.head.appendChild(script);",
    "  }",
    "  function hook(name) {",
    "    var original = window.history[name];",
    "    if (typeof original !== 'function') {",
    "      return;",
    "    }",
    "    window.history[name] = function () {",
    "      var result = original.apply(this, arguments);",
    "      render();",
    "      return result;",
    "    };",
    "  }",
    '  hook("pushState");',
    '  hook("replaceState");',
    '  window.addEventListener("popstate", render);',
    "  render();",
    "})();",
  ].join("\n");

  return [
    INJECTOR_NOTE,
    `<script id="rm-preflight-jsonld-data" type="application/json">${payload}</script>`,
    `<script>\n${script}\n</script>`,
  ].join("\n");
};

/**
 * What to paste into a single page's Page Settings > Custom Code (head).
 * This is the static, crawler-safe path for pages that are not CMS-driven.
 */
export const buildPageCustomCode = (
  config: SchemaSiteConfig,
  page: PageContent,
  options: BuildPageGraphOptions = {}
): string => renderJsonLdScript(buildPageGraph(config, page, options));

/**
 * The value written into a CMS item's schema field. The collection page
 * template renders it with a `{{field}}` binding, which Framer resolves
 * server-side — so CMS pages get static, per-item structured data.
 */
export const buildCmsFieldValue = (
  config: SchemaSiteConfig,
  page: PageContent,
  options: BuildPageGraphOptions = {}
): string => serializeGraph(buildPageGraph(config, page, options), false);

/**
 * The single snippet for Site Settings > Custom Code (head).
 *
 * Two parts, deliberately:
 *  - The site graph is emitted as a real `<script type="application/ld+json">`,
 *    so it is in the static HTML of every page. Crawlers that never run JS —
 *    which is most LLM crawlers — still get Organization, WebSite and the
 *    service/work index.
 *  - Page-specific nodes follow in a small injector, because a site-wide
 *    snippet is byte-identical on every page and cannot vary any other way.
 *
 * CMS pages are deliberately NOT included. They get fully static per-item
 * output through their collection's schema field, and inlining 100+ item
 * graphs here would ship a quarter-megabyte of JSON to every visitor.
 */
export const buildCombinedSiteCustomCode = (
  config: SchemaSiteConfig,
  pageEntries: readonly PathGraphEntry[]
): string => {
  const parts = [buildSiteWideCustomCode(config)];
  if (pageEntries.length > 0) {
    parts.push(buildPathInjectorSnippet(pageEntries));
  }
  return parts.join("\n\n");
};

const BYTES_PER_KB = 1024;

/** Rough transferred size, so the panel can warn before this gets silly. */
export const estimateSnippetKb = (snippet: string): number =>
  Math.round((new TextEncoder().encode(snippet).length / BYTES_PER_KB) * 10) /
  10;

/* ------------------------------------------------------------------ *
 * CMS collection templates
 * ------------------------------------------------------------------ */

/**
 * Field NAMES (not ids) for the roles a collection template binds. Framer's
 * page custom code substitutes by the name shown in the CMS, so these have to
 * match what the editor sees.
 */
export interface CmsTemplateFieldNames {
  title?: string;
  description?: string;
  image?: string;
  datePublished?: string;
  /** Field holding the item's URL slug. Framer exposes this as a field too. */
  slug?: string;
}

export interface CmsTemplateOptions {
  kind: PageKind;
  pathPrefix: string;
  fieldNames: CmsTemplateFieldNames;
}

/**
 * One snippet per collection, pasted into the collection PAGE TEMPLATE's
 * Page Settings > Custom Code (head) — not the index page.
 *
 * Every per-item value is a `{{Field}}` binding that Framer resolves server
 * side, so each published item carries its own static JSON-LD. Nothing is
 * written to the CMS and nothing is injected at runtime: this is the only way
 * to get genuinely static per-page structured data out of a plugin, because
 * the API has no per-page custom code write.
 */
export const buildCmsTemplateGraph = (
  config: SchemaSiteConfig,
  options: CmsTemplateOptions
): SchemaGraph => {
  const { fieldNames, kind, pathPrefix } = options;
  const slugBinding = templateBinding(fieldNames.slug ?? "Slug");
  const page: PageContent = {
    datePublished: fieldNames.datePublished
      ? templateBinding(fieldNames.datePublished)
      : undefined,
    description: fieldNames.description
      ? templateBinding(fieldNames.description)
      : undefined,
    imageUrl: fieldNames.image ? templateBinding(fieldNames.image) : undefined,
    path: `${normalizePath(pathPrefix)}/${slugBinding}`,
    source: "cms",
    title: fieldNames.title ? templateBinding(fieldNames.title) : slugBinding,
  };
  return buildPageGraph(config, page, { kind });
};

export const buildCmsTemplateSnippet = (
  config: SchemaSiteConfig,
  options: CmsTemplateOptions
): string =>
  [
    `<!-- RoleModel Preflight: ${options.pathPrefix} structured data.`,
    "     Paste into the COLLECTION PAGE TEMPLATE's Page Settings > Custom Code",
    "     (end of head). Not the index page. Framer fills each {{Field}} per item. -->",
    renderJsonLdScript(buildCmsTemplateGraph(config, options)),
  ].join("\n");

/** Roles a collection template still needs a field for, in plain words. */
export const missingTemplateBindings = (
  fieldNames: CmsTemplateFieldNames
): string[] => {
  const missing: string[] = [];
  if (!fieldNames.title) {
    missing.push("title");
  }
  if (!fieldNames.slug) {
    missing.push("slug");
  }
  return missing;
};
