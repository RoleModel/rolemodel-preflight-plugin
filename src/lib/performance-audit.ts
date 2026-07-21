export type PerformanceSeverity = "critical" | "warning" | "info";

export interface PerformanceFinding {
  canvasImageUrl?: string;
  canvasInstanceCount?: number;
  canvasNodeId?: string;
  canvasTargets?: { id: string; label: string }[];
  canvasTargetLabel?: string;
  codeFilePath?: string;
  detail: string;
  id: string;
  recommendation: string;
  pageNodeId?: string;
  pagePath?: string;
  severity: PerformanceSeverity;
  title: string;
}

export interface PerformanceMetrics {
  cls?: string;
  fcp?: string;
  lcp?: string;
  performanceScore?: number;
  speedIndex?: string;
  tbt?: string;
  totalBytes?: string;
}

export interface PerformanceAuditResult {
  findings: PerformanceFinding[];
  metrics: PerformanceMetrics;
  source: "pagespeed" | "project";
}

export interface CodeFileSource {
  content: string;
  path: string;
}

export interface CanvasImageSource {
  id: string;
  name?: string | null;
  url: string;
}

interface LighthouseAudit {
  details?: {
    items?: Record<string, unknown>[];
    overallSavingsBytes?: number;
    overallSavingsMs?: number;
  };
  displayValue?: string;
  numericValue?: number;
  score?: number | null;
  title?: string;
}

interface PageSpeedPayload {
  error?: { message?: string };
  lighthouseResult?: {
    audits?: Record<string, LighthouseAudit>;
    categories?: { performance?: { score?: number | null } };
  };
}

const HIDDEN_TEXT_PATTERN =
  /initial\s*[:=]\s*\{?[\s\S]{0,220}?opacity\s*:\s*0/iu;
const TEXT_ANIMATION_PATTERN = /(?:letter|word|text|title|heading|blur)/iu;
const LOAD_ANIMATION_PATTERN =
  /(?:blurTrigger\s*=\s*["']load["']|setTimeout\s*\([\s\S]{0,120}setShouldAnimate)/iu;
const LEGACY_RASTER_PATTERN = /\.(?:png|jpe?g)(?:\?|$)/iu;
const FRAMER_IMAGE_HOST_PATTERN = /(?:^|\.)framerusercontent\.com$/iu;

const isActionableLegacyRaster = (url: string): boolean => {
  if (!LEGACY_RASTER_PATTERN.test(url)) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      !FRAMER_IMAGE_HOST_PATTERN.test(parsedUrl.hostname)
    );
  } catch {
    return false;
  }
};

const metric = (audit: LighthouseAudit | undefined): string | undefined =>
  audit?.displayValue;

const pageSpeedFinding = (
  audits: Record<string, LighthouseAudit>,
  id: string,
  severity: PerformanceSeverity,
  recommendation: string
): PerformanceFinding | null => {
  const audit = audits[id];
  if (!audit || audit.score === 1 || audit.score === null) {
    return null;
  }
  return {
    detail: audit.displayValue ?? "PageSpeed reported an unresolved issue.",
    id: `pagespeed-${id}`,
    recommendation,
    severity,
    title: audit.title ?? id,
  };
};

export const analyzeCodePerformance = (
  files: readonly CodeFileSource[]
): PerformanceAuditResult => {
  const findings: PerformanceFinding[] = [];

  for (const file of files) {
    if (
      HIDDEN_TEXT_PATTERN.test(file.content) &&
      TEXT_ANIMATION_PATTERN.test(file.content) &&
      LOAD_ANIMATION_PATTERN.test(file.content)
    ) {
      findings.push({
        codeFilePath: file.path,
        detail:
          "Important text appears to begin at opacity 0 and waits for a load-triggered animation.",
        id: `hidden-text-${file.path}`,
        recommendation:
          "Render load-triggered text visible on the first frame. Reserve hidden initial states for below-fold in-view animation.",
        severity: "critical",
        title: "Text may be hidden until hydration",
      });
    }

    if (
      /from\s+["']three["']|three\.module|@react-three/iu.test(file.content)
    ) {
      findings.push({
        codeFilePath: file.path,
        detail: "This code file loads a Three.js/WebGL dependency.",
        id: `three-${file.path}`,
        recommendation:
          "Keep the component off critical pages or load the 3D implementation only after interaction/in-view.",
        severity: "warning",
        title: "Heavy 3D runtime dependency",
      });
    }
  }

  return { findings, metrics: {}, source: "project" };
};

export const analyzeCanvasImages = (
  images: readonly CanvasImageSource[]
): PerformanceFinding[] => {
  const uniqueImages = new Map<string, CanvasImageSource>();
  for (const image of images) {
    if (isActionableLegacyRaster(image.url) && !uniqueImages.has(image.url)) {
      uniqueImages.set(image.url, image);
    }
  }

  return [...uniqueImages.values()].map((image) => ({
    canvasImageUrl: image.url,
    canvasNodeId: image.id,
    detail: `${image.name?.trim() || "Image"} uses a PNG or JPEG source.`,
    id: `canvas-image-${image.id}`,
    recommendation:
      "Convert photographic assets to WebP/AVIF and verify the responsive crop at each breakpoint.",
    severity: "warning" as const,
    title: "Legacy raster image instance",
  }));
};

export const runPageSpeedAudit = async (
  url: string,
  apiKey?: string
): Promise<PerformanceAuditResult> => {
  const endpoint = new URL(
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
  );
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", "mobile");
  for (const category of [
    "performance",
    "accessibility",
    "best-practices",
    "seo",
  ]) {
    endpoint.searchParams.append("category", category);
  }
  if (apiKey?.trim()) {
    endpoint.searchParams.set("key", apiKey.trim());
  }

  const response = await fetch(endpoint);
  const payload = (await response.json()) as PageSpeedPayload;
  if (!response.ok || payload.error) {
    throw new Error(
      payload.error?.message ?? `PageSpeed returned HTTP ${response.status}.`
    );
  }

  const lighthouse = payload.lighthouseResult;
  const audits = lighthouse?.audits ?? {};
  const candidates = [
    pageSpeedFinding(
      audits,
      "largest-contentful-paint",
      "critical",
      "Identify the LCP element and remove delayed visibility, oversized media, and render-blocking dependencies from its path."
    ),
    pageSpeedFinding(
      audits,
      "render-blocking-resources",
      "critical",
      "Remove or defer non-critical stylesheets and scripts from the initial render path."
    ),
    pageSpeedFinding(
      audits,
      "unused-javascript",
      "warning",
      "Remove unused code components and delay analytics, 3D, and interaction bundles until needed."
    ),
    pageSpeedFinding(
      audits,
      "offscreen-images",
      "warning",
      "Lazy-load below-fold images and avoid background images on hidden mobile sections."
    ),
    pageSpeedFinding(
      audits,
      "uses-responsive-images",
      "warning",
      "Resize source assets and use Framer responsive image controls rather than raw background URLs."
    ),
    pageSpeedFinding(
      audits,
      "modern-image-formats",
      "warning",
      "Convert PNG/JPEG photography to WebP or AVIF."
    ),
    pageSpeedFinding(
      audits,
      "font-display",
      "warning",
      "Reduce font families and weights, and ensure text stays visible during font loading."
    ),
    pageSpeedFinding(
      audits,
      "dom-size",
      "warning",
      "Reduce nested decorative layers and repeated component markup on the landing page."
    ),
  ];

  return {
    findings: candidates.filter(
      (finding): finding is PerformanceFinding => finding !== null
    ),
    metrics: {
      cls: metric(audits["cumulative-layout-shift"]),
      fcp: metric(audits["first-contentful-paint"]),
      lcp: metric(audits["largest-contentful-paint"]),
      performanceScore:
        typeof lighthouse?.categories?.performance?.score === "number"
          ? Math.round(lighthouse.categories.performance.score * 100)
          : undefined,
      speedIndex: metric(audits["speed-index"]),
      tbt: metric(audits["total-blocking-time"]),
      totalBytes: metric(audits["total-byte-weight"]),
    },
    source: "pagespeed",
  };
};
