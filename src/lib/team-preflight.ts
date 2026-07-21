export interface LinkCandidate {
  source: string;
  nodeId?: string;
  label?: string;
  canClearLink?: boolean;
  value: unknown;
}

export interface TextCandidate {
  source: string;
  nodeId?: string;
  text: string;
}

export interface ContrastCandidate {
  source: string;
  nodeId?: string;
  foreground: string | null;
  background: string | null;
  text?: string;
}

export interface TeamPreflightInput {
  pagePaths: string[];
  /**
   * Page paths containing a dynamic segment, in Framer's own templated
   * form (e.g. "/blog/:slug"). A real resolved URL like "/blog/my-post"
   * never appears in `pagePaths` itself, since the page node only exposes
   * the template — links matching one of these templates are treated as
   * valid even though the exact path isn't listed.
   */
  dynamicPagePaths?: string[];
  /** Existing WebPageNode ids. When omitted, page-id link validation is skipped. */
  webPageIds?: string[];
  /** Existing CMS collection item ids. When omitted, CMS-item link validation is skipped. */
  collectionItemIds?: string[];
  links: LinkCandidate[];
  texts: TextCandidate[];
  contrastPairs: ContrastCandidate[];
}

export interface TeamPreflightOptions {
  checkExternalLinks: boolean;
  checkColorContrast: boolean;
  checkSpelling: boolean;
  checkPunctuation: boolean;
}

export type LinkIssueSeverity = "error" | "warning" | "info";

export interface LinkIssue {
  severity: LinkIssueSeverity;
  source: string;
  href: string;
  reason: string;
  nodeId?: string;
  canClearLink?: boolean;
}

export interface PunctuationIssue {
  source: string;
  text: string;
  reason: string;
  nodeId?: string;
}

export interface SpellingIssue {
  source: string;
  word: string;
  message: string;
  suggestions: string[];
  nodeId?: string;
}

export interface ContrastIssue {
  source: string;
  foreground: string;
  background: string;
  ratio: number;
  requiredRatio: number;
  nodeId?: string;
}

export interface ExternalLinkStatus {
  ok: boolean;
  status?: number;
  reason?: string;
  unverified?: boolean;
}

export interface TeamPreflightReport {
  linkIssues: LinkIssue[];
  punctuationIssues: PunctuationIssue[];
  spellingIssues: SpellingIssue[];
  contrastIssues: ContrastIssue[];
  /** Text/background pairs where both colors could actually be resolved. */
  contrastPairsChecked: number;
  externalLinksChecked: number;
  externalLinksUnverified: number;
  checkedTextNodes: number;
}

type SpellingProvider = (texts: TextCandidate[]) => Promise<SpellingIssue[]>;
type ExternalLinkProvider = (
  urls: string[]
) => Promise<Map<string, ExternalLinkStatus>>;

const PLACEHOLDER_URL_RE =
  /(?:todo|placeholder|example\.com|your-domain|domain\.com)/iu;
const SCRIPT_PLACEHOLDER_URL = ["javascript", "void(0)"].join(":");
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const RGB_COLOR_RE =
  /^rgba?\(\s*(?<r>\d+(?:\.\d+)?)\s*,\s*(?<g>\d+(?:\.\d+)?)\s*,\s*(?<b>\d+(?:\.\d+)?)(?:\s*,\s*(?<a>[\d.]+))?\s*\)$/iu;

const normalizePagePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+/u, "").replace(/\/+$/u, "")}`;
};

const pathFromUrlLike = (href: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return normalizePagePath(trimmed.split(/[?#]/u)[0] ?? "/");
  }

  try {
    const url = new URL(trimmed);
    return normalizePagePath(url.pathname || "/");
  } catch {
    return null;
  }
};

export interface WebPageLinkTarget {
  webPageId: string;
  collectionItemId?: string;
}

/**
 * Framer stores internal page links as `{ type: "webPage", webPageId, collectionItemId? }`.
 * These reference nodes by id, so a deleted page leaves a dangling id behind.
 */
export const extractWebPageLink = (
  value: unknown
): WebPageLinkTarget | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "webPage" || typeof record.webPageId !== "string") {
    return null;
  }

  const webPageId = record.webPageId.trim();
  if (!webPageId) {
    return null;
  }

  const collectionItemId =
    typeof record.collectionItemId === "string" &&
    record.collectionItemId.trim()
      ? record.collectionItemId.trim()
      : undefined;

  return { collectionItemId, webPageId };
};

export const extractHref = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;

  if (typeof record.url === "string") {
    return record.url.trim() || null;
  }
  if (typeof record.href === "string") {
    return record.href.trim() || null;
  }
  if (typeof record.value === "string") {
    return record.value.trim() || null;
  }

  if (record.type === "url" && typeof record.url === "string") {
    return record.url.trim() || null;
  }
  if (record.type === "webPage" && typeof record.path === "string") {
    return normalizePagePath(record.path);
  }

  return null;
};

// Only whole camelCase/snake_case words, not substrings — "button", "cta",
// and "action" were previously matched as bare substrings, which meant
// unrelated style props like "buttonBackgroundColor" or "ctaPadding" were
// misdetected as links (their color/size string got treated as a broken
// href). Words that are essentially never used as a link property's name
// are deliberately excluded, even though they're common link-context terms.
const LINK_LIKE_WORDS = new Set(["href", "link", "url", "destination"]);

const splitIdentifierWords = (key: string): string[] =>
  key
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .replaceAll(/[_-]+/gu, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);

const isLinkLikeKey = (key: string): boolean =>
  splitIdentifierWords(key).some((word) => LINK_LIKE_WORDS.has(word));

// A key-matched control's value still isn't necessarily a URL — e.g. an
// Enum control literally named "urlSource" with options like "canonical" /
// "current" / "custom" selects a *strategy*, not a link. Bare words with no
// path/URL structure at all are almost certainly not an attempted link.
const PLAUSIBLE_URL_VALUE_RE = /[./:#]/u;

interface ResolvedLinkValue {
  isLinkShapedObject: boolean;
  webPageLink: WebPageLinkTarget | null;
  href: string | null;
}

const resolveLinkValue = (key: string, child: unknown): ResolvedLinkValue => {
  // Framer link controls have unambiguous value shapes ({type: "webPage"} /
  // {type: "url"}), so detect those regardless of the prop's name —
  // otherwise custom-named link props with missing targets never surface.
  const isLinkShapedObject =
    !!child &&
    typeof child === "object" &&
    ((child as Record<string, unknown>).type === "webPage" ||
      (child as Record<string, unknown>).type === "url");
  const webPageLink = extractWebPageLink(child);
  const rawHref =
    isLinkLikeKey(key) || isLinkShapedObject ? extractHref(child) : null;
  const href =
    rawHref && (isLinkShapedObject || PLAUSIBLE_URL_VALUE_RE.test(rawHref))
      ? rawHref
      : null;

  return { href, isLinkShapedObject, webPageLink };
};

export const findLinkLikeValues = (
  value: unknown,
  source: string,
  nodeId?: string
): LinkCandidate[] => {
  const links: LinkCandidate[] = [];
  const seen = new Set<unknown>();

  const visit = (nextValue: unknown, path: string) => {
    if (!nextValue || typeof nextValue !== "object") {
      return;
    }
    if (seen.has(nextValue)) {
      return;
    }
    seen.add(nextValue);

    const record = nextValue as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      const childPath = `${path}.${key}`;
      const { href, isLinkShapedObject, webPageLink } = resolveLinkValue(
        key,
        child
      );
      if (href || webPageLink || isLinkShapedObject) {
        links.push({
          label: key,
          nodeId,
          source: `${source} ${childPath}`,
          value: webPageLink ? child : (href ?? child),
        });
      }

      // A collected link object's inner fields are not independent links.
      if (child && typeof child === "object" && !isLinkShapedObject) {
        visit(child, childPath);
      }
    }
  };

  visit(value, "controls");
  return links;
};

const EXTERNAL_HTTP_URL_RE = /^https?:\/\//iu;
const IGNORED_LINK_SCHEME_RE = /^(?:mailto|tel|sms):/iu;
const UNSUPPORTED_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/iu;

const isExternalHttpUrl = (href: string): boolean =>
  EXTERNAL_HTTP_URL_RE.test(href);

const shouldIgnoreLink = (href: string): boolean =>
  IGNORED_LINK_SCHEME_RE.test(href);

const evaluateWebPageLinkCandidate = (
  candidate: LinkCandidate,
  webPageLink: WebPageLinkTarget,
  href: string | null,
  webPageIds: Set<string> | null,
  collectionItemIds: Set<string> | null
): LinkIssue[] => {
  const { canClearLink, nodeId, source } = candidate;
  const issues: LinkIssue[] = [];

  if (webPageIds && !webPageIds.has(webPageLink.webPageId)) {
    issues.push({
      canClearLink,
      href: href ?? `webPage:${webPageLink.webPageId}`,
      nodeId,
      reason:
        "Broken internal link: the linked page no longer exists in this project.",
      severity: "error",
      source,
    });
  }
  if (
    webPageLink.collectionItemId &&
    collectionItemIds &&
    !collectionItemIds.has(webPageLink.collectionItemId)
  ) {
    issues.push({
      canClearLink,
      href: href ?? `collectionItem:${webPageLink.collectionItemId}`,
      nodeId,
      reason:
        "Broken internal link: the linked CMS item no longer exists in this project.",
      severity: "error",
      source,
    });
  }
  return issues;
};

const evaluateExternalLinkStatusIssue = (
  candidate: LinkCandidate,
  href: string,
  externalStatuses: Map<string, ExternalLinkStatus>
): LinkIssue[] => {
  const { canClearLink, nodeId, source } = candidate;
  const status = externalStatuses.get(href);
  if (!status) {
    return [];
  }

  if (status.unverified) {
    // Most major platforms (Vimeo, YouTube, Facebook, LinkedIn, Instagram,
    // Calendly, etc.) block cross-origin fetches from the plugin via CORS —
    // that's the browser's own security policy, not evidence the link is
    // broken. Surfacing every one as a finding produces mass false
    // positives; `externalLinksUnverified` on the report still tracks the
    // count for the summary text without turning each into an "issue."
    return [];
  }

  if (!status.ok) {
    return [
      {
        canClearLink,
        href,
        nodeId,
        reason: status.status
          ? `External link returned HTTP ${status.status}.`
          : (status.reason ?? "External link failed."),
        severity: "error",
        source,
      },
    ];
  }

  return [];
};

// Converts a Framer path template ("/blog/:slug") into a regex that
// matches any resolved URL for it ("/blog/my-post"), escaping the literal
// segments and treating every ":name" segment as a wildcard.
const dynamicPagePathToRegExp = (templatePath: string): RegExp => {
  const escaped = templatePath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = escaped.replaceAll(/:[^/]+/gu, "[^/]+");
  return new RegExp(`^${pattern}$`, "u");
};

const matchesDynamicPagePath = (
  path: string,
  dynamicPagePaths: string[]
): boolean =>
  dynamicPagePaths.some((templatePath) =>
    dynamicPagePathToRegExp(templatePath).test(path)
  );

const evaluateLinkCandidate = (
  candidate: LinkCandidate,
  pagePaths: Set<string>,
  dynamicPagePaths: string[],
  webPageIds: Set<string> | null,
  collectionItemIds: Set<string> | null,
  externalStatuses: Map<string, ExternalLinkStatus>,
  checkExternalLinks: boolean
): LinkIssue[] => {
  const href = extractHref(candidate.value);
  const { canClearLink, nodeId, source } = candidate;

  const webPageLink = extractWebPageLink(candidate.value);
  if (webPageLink) {
    return evaluateWebPageLinkCandidate(
      candidate,
      webPageLink,
      href,
      webPageIds,
      collectionItemIds
    );
  }

  if (!href) {
    return [
      {
        canClearLink,
        href: "",
        nodeId,
        reason: "Empty link value.",
        severity: "error",
        source,
      },
    ];
  }

  if (
    href === "#" ||
    href === "/" ||
    href.toLowerCase() === SCRIPT_PLACEHOLDER_URL
  ) {
    return [
      {
        canClearLink,
        href,
        nodeId,
        reason: "Placeholder link.",
        severity: "warning",
        source,
      },
    ];
  }

  const issues: LinkIssue[] = [];
  if (PLACEHOLDER_URL_RE.test(href)) {
    issues.push({
      canClearLink,
      href,
      nodeId,
      reason: "Placeholder or example URL.",
      severity: "warning",
      source,
    });
  }

  if (shouldIgnoreLink(href)) {
    return issues;
  }

  if (isExternalHttpUrl(href)) {
    if (!checkExternalLinks) {
      return issues;
    }
    return [
      ...issues,
      ...evaluateExternalLinkStatusIssue(candidate, href, externalStatuses),
    ];
  }

  if (UNSUPPORTED_PROTOCOL_RE.test(href)) {
    return [
      ...issues,
      {
        canClearLink,
        href,
        nodeId,
        reason: "Unsupported or malformed link protocol.",
        severity: "warning",
        source,
      },
    ];
  }

  const path = pathFromUrlLike(href);
  if (!path) {
    return [
      ...issues,
      {
        canClearLink,
        href,
        nodeId,
        reason: "Could not parse link target.",
        severity: "warning",
        source,
      },
    ];
  }

  if (
    !(pagePaths.has(path) || matchesDynamicPagePath(path, dynamicPagePaths))
  ) {
    issues.push({
      canClearLink,
      href,
      nodeId,
      reason: `Internal page path ${path} was not found.`,
      severity: "error",
      source,
    });
  }

  return issues;
};

const PUNCTUATION_RULES: { reason: string; re: RegExp }[] = [
  { re: / {2,}/u, reason: "Double spaces." },
  { re: /\s+[,.!?;:]/u, reason: "Space before punctuation." },
  { re: /[!?.,]{3,}/u, reason: "Repeated punctuation." },
  { re: /[.!?][A-Z]/u, reason: "Missing space after sentence punctuation." },
  { re: /(?:“[^”]*$|‘[^’]*$)/u, reason: "Likely smart quote mismatch." },
  {
    re: /\b(?:lorem ipsum|todo|placeholder)\b/iu,
    reason: "Placeholder copy.",
  },
];

export const findPunctuationIssues = (
  texts: TextCandidate[]
): PunctuationIssue[] => {
  const issues: PunctuationIssue[] = [];

  for (const row of texts) {
    const raw = row.text.trim();
    const collapsed = raw.replaceAll(/\s+/gu, " ").trim();
    if (collapsed.length < 2) {
      continue;
    }

    for (const rule of PUNCTUATION_RULES) {
      if (rule.re.test(raw) || rule.re.test(collapsed)) {
        issues.push({
          nodeId: row.nodeId,
          reason: rule.reason,
          source: row.source,
          text: collapsed.slice(0, 180),
        });
      }
    }
  }

  return issues;
};

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const parseHexColor = (color: string): Rgb | null => {
  if (!HEX_COLOR_RE.test(color)) {
    return null;
  }
  const raw = color.slice(1);
  const expanded =
    raw.length === 3 ? [...raw].map((char) => `${char}${char}`).join("") : raw;

  const rgb = expanded.slice(0, 6);
  const alpha =
    expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;

  return {
    a: alpha,
    b: Number.parseInt(rgb.slice(4, 6), 16),
    g: Number.parseInt(rgb.slice(2, 4), 16),
    r: Number.parseInt(rgb.slice(0, 2), 16),
  };
};

const parseRgbColor = (color: string): Rgb | null => {
  const match = color.match(RGB_COLOR_RE);
  const groups = match?.groups;
  if (!groups) {
    return null;
  }

  return {
    a: groups.a ? Number(groups.a) : 1,
    b: Number(groups.b),
    g: Number(groups.g),
    r: Number(groups.r),
  };
};

export const parseColor = (color: string | null): Rgb | null => {
  if (!color) {
    return null;
  }
  const trimmed = color.trim();
  return parseHexColor(trimmed) ?? parseRgbColor(trimmed);
};

const channelLuminance = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (color: Rgb): number =>
  0.2126 * channelLuminance(color.r) +
  0.7152 * channelLuminance(color.g) +
  0.0722 * channelLuminance(color.b);

export const contrastRatio = (
  foreground: string,
  background: string
): number | null => {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg || fg.a < 1 || bg.a < 1) {
    return null;
  }

  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);

  return (lighter + 0.05) / (darker + 0.05);
};

export const findContrastIssues = (
  candidates: ContrastCandidate[]
): ContrastIssue[] => {
  const issues: ContrastIssue[] = [];

  for (const candidate of candidates) {
    if (!candidate.foreground || !candidate.background) {
      continue;
    }
    const ratio = contrastRatio(candidate.foreground, candidate.background);
    if (!ratio) {
      continue;
    }

    const requiredRatio = 4.5;
    if (ratio < requiredRatio) {
      issues.push({
        background: candidate.background,
        foreground: candidate.foreground,
        nodeId: candidate.nodeId,
        ratio,
        requiredRatio,
        source: candidate.source,
      });
    }
  }

  return issues;
};

export const runTeamPreflight = async (
  input: TeamPreflightInput,
  options: TeamPreflightOptions,
  providers: {
    checkExternalLinks?: ExternalLinkProvider;
    checkSpelling?: SpellingProvider;
  } = {}
): Promise<TeamPreflightReport> => {
  const pagePaths = new Set(input.pagePaths.map(normalizePagePath));
  const dynamicPagePaths = (input.dynamicPagePaths ?? []).map(
    normalizePagePath
  );
  const webPageIds = input.webPageIds ? new Set(input.webPageIds) : null;
  const collectionItemIds = input.collectionItemIds
    ? new Set(input.collectionItemIds)
    : null;
  const externalUrls = [
    ...new Set(
      input.links
        .map((link) => extractHref(link.value))
        .filter((href): href is string => typeof href === "string")
        .filter((href) => isExternalHttpUrl(href))
    ),
  ];
  const externalStatuses =
    options.checkExternalLinks && providers.checkExternalLinks
      ? await providers.checkExternalLinks(externalUrls)
      : new Map<string, ExternalLinkStatus>();

  const linkIssues = input.links.flatMap((candidate) =>
    evaluateLinkCandidate(
      candidate,
      pagePaths,
      dynamicPagePaths,
      webPageIds,
      collectionItemIds,
      externalStatuses,
      options.checkExternalLinks
    )
  );

  const punctuationIssues = options.checkPunctuation
    ? findPunctuationIssues(input.texts)
    : [];
  const spellingIssues =
    options.checkSpelling && providers.checkSpelling
      ? await providers.checkSpelling(input.texts)
      : [];
  const contrastIssues = options.checkColorContrast
    ? findContrastIssues(input.contrastPairs)
    : [];

  return {
    checkedTextNodes: input.texts.length,
    contrastIssues,
    contrastPairsChecked: input.contrastPairs.filter(
      (pair) => pair.foreground && pair.background
    ).length,
    externalLinksChecked: externalStatuses.size,
    externalLinksUnverified: [...externalStatuses.values()].filter(
      (status) => status.unverified
    ).length,
    linkIssues,
    punctuationIssues,
    spellingIssues,
  };
};

const countBySeverity = (
  issues: LinkIssue[],
  severity: LinkIssueSeverity
): number => issues.filter((issue) => issue.severity === severity).length;

export const formatTeamPreflightReport = (
  report: TeamPreflightReport,
  options: TeamPreflightOptions
): string => {
  const lines: string[] = ["Content + Links"];

  const linkErrors = countBySeverity(report.linkIssues, "error");
  const linkWarnings = countBySeverity(report.linkIssues, "warning");
  const linkInfo = countBySeverity(report.linkIssues, "info");

  lines.push(
    `Links: ${linkErrors} error(s), ${linkWarnings} warning(s), ${linkInfo} note(s).`,
    options.checkExternalLinks
      ? `External link verification checked ${report.externalLinksChecked} URL(s); ${report.externalLinksUnverified} could not be verified from the plugin.`
      : "External dead-link checks skipped."
  );

  if (report.linkIssues.length > 0) {
    lines.push(
      ...report.linkIssues
        .slice(0, 40)
        .map(
          (issue) =>
            `  • [${issue.severity}] ${issue.source}\n      ${issue.href || "(empty)"} — ${issue.reason}`
        )
    );
    if (report.linkIssues.length > 40) {
      lines.push(`  … +${report.linkIssues.length - 40} more link issue(s)`);
    }
  }

  lines.push(
    "",
    options.checkPunctuation
      ? `Punctuation/style: ${report.punctuationIssues.length} issue(s) across ${report.checkedTextNodes} text node(s).`
      : "Punctuation/style checks skipped."
  );
  if (report.punctuationIssues.length > 0) {
    lines.push(
      ...report.punctuationIssues
        .slice(0, 30)
        .map(
          (issue) => `  • ${issue.source}\n      ${issue.reason} ${issue.text}`
        )
    );
    if (report.punctuationIssues.length > 30) {
      lines.push(
        `  … +${report.punctuationIssues.length - 30} more punctuation issue(s)`
      );
    }
  }

  lines.push(
    "",
    options.checkSpelling
      ? `Spelling: ${report.spellingIssues.length} issue(s).`
      : "Spelling checks skipped."
  );
  if (report.spellingIssues.length > 0) {
    lines.push(
      ...report.spellingIssues.slice(0, 30).map((issue) => {
        const suggestions =
          issue.suggestions.length > 0
            ? ` Suggestions: ${issue.suggestions.join(", ")}`
            : "";
        return `  • ${issue.source}\n      ${issue.word} — ${issue.message}.${suggestions}`;
      })
    );
    if (report.spellingIssues.length > 30) {
      lines.push(
        `  … +${report.spellingIssues.length - 30} more spelling issue(s)`
      );
    }
  }

  lines.push(
    "",
    options.checkColorContrast
      ? `Color contrast: ${report.contrastIssues.length} issue(s) across ${report.contrastPairsChecked} resolvable text/background pair(s).`
      : "Color contrast checks skipped."
  );
  if (options.checkColorContrast && report.contrastPairsChecked === 0) {
    lines.push(
      "  No text/background color pairs could be resolved — text without a detectable solid background, or using color types the plugin cannot read, is skipped."
    );
  }
  if (report.contrastIssues.length > 0) {
    lines.push(
      ...report.contrastIssues
        .slice(0, 30)
        .map(
          (issue) =>
            `  • ${issue.source}\n      ${issue.foreground} on ${issue.background} = ${issue.ratio.toFixed(2)}:1; needs ${issue.requiredRatio}:1.`
        )
    );
    if (report.contrastIssues.length > 30) {
      lines.push(
        `  … +${report.contrastIssues.length - 30} more contrast issue(s)`
      );
    }
  }

  return lines.join("\n");
};
