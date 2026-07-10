export interface LinkCandidate {
  source: string;
  nodeId?: string;
  label?: string;
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
  externalLinksChecked: number;
  externalLinksUnverified: number;
  checkedTextNodes: number;
}

type SpellingProvider = (texts: TextCandidate[]) => Promise<SpellingIssue[]>;
type ExternalLinkProvider = (
  urls: string[]
) => Promise<Map<string, ExternalLinkStatus>>;

const PLACEHOLDER_URL_RE =
  /(?:todo|placeholder|example\.com|your-domain|domain\.com)/i;
const SCRIPT_PLACEHOLDER_URL = ["javascript", "void(0)"].join(":");
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR_RE =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)$/i;

function normalizePagePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function pathFromUrlLike(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return normalizePagePath(trimmed.split(/[?#]/)[0] ?? "/");
  }

  try {
    const url = new URL(trimmed);
    return normalizePagePath(url.pathname || "/");
  } catch {
    return null;
  }
}

export function extractHref(value: unknown): string | null {
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
}

export function findLinkLikeValues(
  value: unknown,
  source: string,
  nodeId?: string
): LinkCandidate[] {
  const links: LinkCandidate[] = [];
  const seen = new Set<unknown>();

  function visit(nextValue: unknown, path: string) {
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
      const keyIsLinkLike =
        /(?:href|link|url|cta|button|destination|action)/i.test(key);
      const href = keyIsLinkLike ? extractHref(child) : null;
      if (href) {
        links.push({
          label: key,
          nodeId,
          source: `${source} ${childPath}`,
          value: href,
        });
      }

      if (child && typeof child === "object") {
        visit(child, childPath);
      }
    }
  }

  visit(value, "controls");
  return links;
}

function isExternalHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function shouldIgnoreLink(href: string): boolean {
  return /^(mailto|tel|sms):/i.test(href);
}

function evaluateLinkCandidate(
  candidate: LinkCandidate,
  pagePaths: Set<string>,
  externalStatuses: Map<string, ExternalLinkStatus>,
  checkExternalLinks: boolean
): LinkIssue[] {
  const href = extractHref(candidate.value);
  const { source } = candidate;
  const { nodeId } = candidate;
  const issues: LinkIssue[] = [];

  if (!href) {
    issues.push({
      href: "",
      nodeId,
      reason: "Empty link value.",
      severity: "error",
      source,
    });
    return issues;
  }

  if (
    href === "#" ||
    href === "/" ||
    href.toLowerCase() === SCRIPT_PLACEHOLDER_URL
  ) {
    issues.push({
      href,
      nodeId,
      reason: "Placeholder link.",
      severity: "warning",
      source,
    });
    return issues;
  }

  if (PLACEHOLDER_URL_RE.test(href)) {
    issues.push({
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

    const status = externalStatuses.get(href);
    if (!status) {
      return issues;
    }

    if (status.unverified) {
      issues.push({
        href,
        nodeId,
        reason:
          status.reason ??
          "External link could not be verified from the plugin.",
        severity: "info",
        source,
      });
    } else if (!status.ok) {
      issues.push({
        href,
        nodeId,
        reason: status.status
          ? `External link returned HTTP ${status.status}.`
          : (status.reason ?? "External link failed."),
        severity: "error",
        source,
      });
    }
    return issues;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    issues.push({
      href,
      nodeId,
      reason: "Unsupported or malformed link protocol.",
      severity: "warning",
      source,
    });
    return issues;
  }

  const path = pathFromUrlLike(href);
  if (!path) {
    issues.push({
      href,
      nodeId,
      reason: "Could not parse link target.",
      severity: "warning",
      source,
    });
    return issues;
  }

  if (!pagePaths.has(path)) {
    issues.push({
      href,
      nodeId,
      reason: `Internal page path ${path} was not found.`,
      severity: "error",
      source,
    });
  }

  return issues;
}

export function findPunctuationIssues(
  texts: TextCandidate[]
): PunctuationIssue[] {
  const issues: PunctuationIssue[] = [];

  const rules: { reason: string; re: RegExp }[] = [
    { re: / {2,}/, reason: "Double spaces." },
    { re: /\s+[,.!?;:]/, reason: "Space before punctuation." },
    { re: /[!?.,]{3,}/, reason: "Repeated punctuation." },
    { re: /[.!?][A-Z]/, reason: "Missing space after sentence punctuation." },
    { re: /(?:“[^”]*$|‘[^’]*$)/, reason: "Likely smart quote mismatch." },
    {
      re: /\b(?:lorem ipsum|todo|placeholder)\b/i,
      reason: "Placeholder copy.",
    },
  ];

  for (const row of texts) {
    const raw = row.text.trim();
    const collapsed = raw.replaceAll(/\s+/g, " ").trim();
    if (collapsed.length < 2) {
      continue;
    }

    for (const rule of rules) {
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
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHexColor(color: string): Rgb | null {
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
}

function parseRgbColor(color: string): Rgb | null {
  const match = color.match(RGB_COLOR_RE);
  if (!match) {
    return null;
  }

  return {
    a: match[4] ? Number(match[4]) : 1,
    b: Number(match[3]),
    g: Number(match[2]),
    r: Number(match[1]),
  };
}

export function parseColor(color: string | null): Rgb | null {
  if (!color) {
    return null;
  }
  const trimmed = color.trim();
  return parseHexColor(trimmed) ?? parseRgbColor(trimmed);
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

export function contrastRatio(
  foreground: string,
  background: string
): number | null {
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
}

export function findContrastIssues(
  candidates: ContrastCandidate[]
): ContrastIssue[] {
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
}

export async function runTeamPreflight(
  input: TeamPreflightInput,
  options: TeamPreflightOptions,
  providers: {
    checkExternalLinks?: ExternalLinkProvider;
    checkSpelling?: SpellingProvider;
  } = {}
): Promise<TeamPreflightReport> {
  const pagePaths = new Set(input.pagePaths.map(normalizePagePath));
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
    externalLinksChecked: externalStatuses.size,
    externalLinksUnverified: [...externalStatuses.values()].filter(
      (status) => status.unverified
    ).length,
    linkIssues,
    punctuationIssues,
    spellingIssues,
  };
}

function countBySeverity(
  issues: LinkIssue[],
  severity: LinkIssueSeverity
): number {
  return issues.filter((issue) => issue.severity === severity).length;
}

export function formatTeamPreflightReport(
  report: TeamPreflightReport,
  options: TeamPreflightOptions
): string {
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
      ? `Color contrast: ${report.contrastIssues.length} issue(s).`
      : "Color contrast checks skipped."
  );
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
}
