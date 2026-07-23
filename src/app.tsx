import {
  framer,
  isComponentNode,
  isDesignPageNode,
  isWebPageNode,
} from "@framer/plugin";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { BatchRenamePanel } from "./batch-rename-panel";
import { FontManagerPanel } from "./font-manager-panel";
import {
  fileBasename,
  findBrokenComponentIssues,
} from "./lib/broken-components";
import type {
  BrokenComponentIssue,
  InstanceRuntimeError,
} from "./lib/broken-components";
import { formatCanvasInstanceReport } from "./lib/canvas-instances";
import {
  findCodeFilePathDriftIssues,
  formatCodeFilePathDriftReport,
} from "./lib/code-file-integrity";
import {
  analyzeCodeHealth,
  extractResolvableImportSpecifiers,
  formatCodeHealthReport,
} from "./lib/code-health";
import type { CodeHealthReport } from "./lib/code-health";
import { findLayoutDriftIssues } from "./lib/layout-drift";
import type { LayoutDriftIssue } from "./lib/layout-drift";
import { fetchManifest, getDefaultManifestUrl } from "./lib/manifest";
import type { Manifest } from "./lib/manifest";
import {
  componentNameForFolder,
  folderFromComponentName,
  formatOrganizePlan,
  planComponentOrganization,
} from "./lib/organize-components";
import type { OrganizePlan } from "./lib/organize-components";
import {
  formatFramerLocalScanReport,
  scanCodeFileSourcesForFramerLocal,
  scanModuleUrlsForFramerLocal,
} from "./lib/scan-framer-local";
import type { CodeFileBundleHit } from "./lib/scan-framer-local";
import {
  createSpacingTemplate,
  defaultSpacingTemplates,
  formatSpacingTemplateSummary,
  parseSpacingTemplates,
} from "./lib/spacing-templates";
import type {
  SpacingBreakpoint,
  SpacingTemplate,
} from "./lib/spacing-templates";
import {
  contrastRatio,
  extractHref,
  extractWebPageLink,
  findLinkLikeValues,
  runTeamPreflight,
} from "./lib/team-preflight";
import type {
  ContrastCandidate,
  ExternalLinkStatus,
  LinkCandidate,
  SpellingIssue,
  TeamPreflightOptions,
  TextCandidate,
} from "./lib/team-preflight";
import { PerformancePanel } from "./performance-panel";
import { UrlBuilderPanel } from "./url-builder-panel";

interface DirectSyncFile {
  path: string;
  syncPath: string;
  content: string;
  uploadPath?: string;
}

interface PreflightSnapshot {
  report: string;
  issues: number;
  hasIssues: boolean;
}

type ViolationCategory =
  | "brokenComponent"
  | "link"
  | "punctuation"
  | "spelling"
  | "contrast"
  | "pathDrift"
  | "layoutDrift"
  | "brokenImport"
  | "nestedLink"
  | "codeBundle";

const VIOLATION_CATEGORY_LABELS: Record<ViolationCategory, string> = {
  brokenComponent: "Broken components",
  brokenImport: "Broken imports",
  codeBundle: "Bundle import issues",
  contrast: "Color contrast",
  layoutDrift: "Layout",
  link: "Links",
  nestedLink: "Nested links",
  pathDrift: "Code file paths",
  punctuation: "Punctuation/style",
  spelling: "Spelling",
};

interface ViolationAction {
  id: string;
  category: ViolationCategory;
  title: string;
  description: string;
  nodeId?: string;
  /** Module URL fallback: re-find an instance by insertURL when the node id went stale. */
  insertURL?: string;
  /** Code file paths a published module expects but cannot resolve. */
  missingFilePaths?: string[];
  codeFileId?: string;
  codeFileName?: string;
  codeFileContent?: string;
  /** Sticky guidance shown after a "Go to"/fix attempt could not complete automatically. */
  note?: string;
  /** Human-readable page/component/layer breadcrumb, resolved during the scan. */
  location?: string;
  /** The link value recorded during the scan, for "Recheck" to compare against. */
  originalHref?: string;
  /** The colors recorded during the scan, for "Recheck" to re-evaluate. */
  originalForeground?: string;
  originalBackground?: string;
  fix?: {
    label: string;
    type:
      | "clearLink"
      | "createRootCodeFileCopy"
      | "moveToRoot"
      | "restoreMissingCodeFiles";
  };
}

type ScanSection =
  | "preflight"
  | "spacing"
  | "performance"
  | "fonts"
  | "organize"
  | "rename"
  | "urlBuilder";

interface OrganizeCanvasRow {
  nodeId: string;
  baseName: string;
  currentFolder: string;
  folder: string;
  reason: string;
}

type OptionalCheckKey = keyof TeamPreflightOptions;

interface SpacingLayoutAttributes {
  padding: `${number}px ${number}px ${number}px ${number}px`;
  gap: `${number}px`;
}

type CodeFileHandle = Awaited<ReturnType<typeof framer.getCodeFiles>>[number];

/**
 * Resolves a relative or `codeFile/`-prefixed import specifier against this
 * project's actual (flat, no "RoleModel/" prefix) code file paths — unlike
 * `resolveSpecifierToRoleModelPath` in code-health.ts, which only makes
 * sense for files synced under a "RoleModel/" folder convention.
 */
const resolveImportSpecifierPath = (
  fromPath: string,
  specifier: string
): string | null => {
  if (specifier.startsWith("codeFile/")) {
    return specifier.slice("codeFile/".length);
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  const stack = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      stack.pop();
    } else if (part !== ".") {
      stack.push(part);
    }
  }
  const joined = stack.join("/");
  return /\.[cm]?[jt]sx?$/iu.test(joined) ? joined : `${joined}.tsx`;
};

/** Finds every code file whose import specifiers point at a file that no longer exists. */
const findBrokenCodeFileImports = (
  codeFiles: readonly CodeFileHandle[]
): { fromFile: string; specifier: string; resolvedPath: string }[] => {
  const pathKeys = new Set(
    codeFiles.map((file) => (file.path || file.name).toLowerCase())
  );
  const broken: {
    fromFile: string;
    specifier: string;
    resolvedPath: string;
  }[] = [];

  for (const file of codeFiles) {
    const fromPath = file.path || file.name;
    for (const specifier of extractResolvableImportSpecifiers(file.content)) {
      const resolvedPath = resolveImportSpecifierPath(fromPath, specifier);
      if (resolvedPath && !pathKeys.has(resolvedPath.toLowerCase())) {
        broken.push({ fromFile: fromPath, resolvedPath, specifier });
      }
    }
  }

  return broken;
};

const DEFAULT_TEAM_PREFLIGHT_OPTIONS: TeamPreflightOptions = {
  checkColorContrast: true,
  checkExternalLinks: false,
  checkPunctuation: true,
  checkSpelling: false,
};

const VIOLATIONS_PAGE_SIZE = 100;
const SPACING_TEMPLATES_PLUGIN_DATA_KEY = "spacing-templates-v1";

const getSpacingLayoutAttributes = (
  row: SpacingBreakpoint
): SpacingLayoutAttributes => ({
  gap: `${row.gap}px`,
  padding: `${row.paddingY}px ${row.paddingX}px ${row.paddingY}px ${row.paddingX}px`,
});

const deriveProjectNodeBaseUrl = (): string => {
  const candidates = [window.location.href, document.referrer].filter(Boolean);
  for (const candidate of candidates) {
    const match = String(candidate).match(
      /(?<projectUrl>https:\/\/framer\.com\/projects\/[^?#]+)/u
    );
    if (match?.groups?.projectUrl) {
      return match.groups.projectUrl;
    }
  }
  return "";
};

const scanCodeHealthSnapshot = async (): Promise<
  PreflightSnapshot & { rawReport: CodeHealthReport }
> => {
  // Attempt to load repo sync files for cross-referencing missing paths.
  // Falls back to an empty list when the dev server isn't available (published plugin).
  let syncFiles: DirectSyncFile[] = [];
  try {
    const filesResponse = await fetch("/__repo/framer-sync-files");
    if (filesResponse.ok) {
      const filesPayload = (await filesResponse.json()) as {
        files?: DirectSyncFile[];
      };
      syncFiles = filesPayload.files ?? [];
    }
  } catch {
    // Dev server not reachable — scan continues without repo reference.
  }

  const framerFiles = await framer.getCodeFiles();
  const rawReport = analyzeCodeHealth({
    framerFiles: framerFiles.map((file) => ({
      content: file.content,
      name: file.name,
      path: file.path,
    })),
    syncFiles,
  });

  return {
    hasIssues:
      rawReport.brokenRelativeImports.length > 0 ||
      rawReport.nestedLinks.length > 0,
    issues:
      rawReport.brokenRelativeImports.length + rawReport.nestedLinks.length,
    rawReport,
    report: formatCodeHealthReport(rawReport),
  };
};

const scanCanvasInstancesSnapshot = async () => {
  const instances = await framer.getNodesWithType("ComponentInstanceNode");
  const summary = instances.map((node) => ({
    componentIdentifier: node.componentIdentifier ?? "",
    componentName: node.componentName,
    id: node.id,
    insertURL: node.insertURL,
  }));
  const seedUrls = [
    ...new Set(summary.map((instance) => instance.insertURL).filter(Boolean)),
  ].filter((url): url is string => typeof url === "string");

  return {
    count: summary.length,
    instances: summary,
    nodes: instances,
    report: formatCanvasInstanceReport(summary),
    seedUrls,
  };
};

interface DesignComponentTreeMaster {
  name: string | null;
  componentName: string | null;
  folderPath: string;
}

interface DesignComponentTree {
  masters: Map<string, DesignComponentTreeMaster>;
  /** Real folder nodes in the design page tree, keyed by their full path. */
  folderNodeIdByPath: Map<string, string>;
  rootIds: string[];
  scannedNodes: number;
}

const MAX_TREE_NODES = 800;
const MAX_TREE_DEPTH = 4;

/**
 * Assets-panel folders for design components are real parent nodes inside
 * design pages — not name prefixes. Walk the design page trees to find every
 * component master, its folder path, and the folder node ids (so components
 * can be moved with setParent instead of renames).
 */
const collectDesignComponentTree = async (): Promise<DesignComponentTree> => {
  const masters = new Map<string, DesignComponentTreeMaster>();
  const folderNodeIdByPath = new Map<string, string>();
  const rootIds: string[] = [];
  let scanned = 0;

  let pages: { id: string }[] = [];
  try {
    pages = await framer.getNodesWithType("DesignPageNode");
  } catch {
    return { folderNodeIdByPath, masters, rootIds, scannedNodes: 0 };
  }

  const visit = async (nodeId: string, path: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH || scanned >= MAX_TREE_NODES) {
      return;
    }

    let children: unknown[] = [];
    try {
      children = await framer.getChildren(nodeId);
    } catch {
      return;
    }

    // Sequential on purpose: this walks the design-page tree via the Framer
    // plugin bridge, which doesn't tolerate a burst of concurrent requests
    // well (observed host-side instability when this was parallelized).
    for (const child of children) {
      scanned += 1;
      if (scanned >= MAX_TREE_NODES) {
        return;
      }

      if (isComponentNode(child)) {
        masters.set(child.id, {
          componentName: child.componentName,
          folderPath: path,
          name: child.name,
        });
        continue;
      }

      const record = child as { id: string; name?: unknown };
      const name = typeof record.name === "string" ? record.name.trim() : "";
      let nextPath = path;
      if (name) {
        nextPath = path ? `${path}/${name}` : name;
        folderNodeIdByPath.set(nextPath, record.id);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await visit(record.id, nextPath, depth + 1);
    }
  };

  rootIds.push(...pages.map((page) => page.id));
  for (const page of pages) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await visit(page.id, "", 0);
  }

  return { folderNodeIdByPath, masters, rootIds, scannedNodes: scanned };
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const NAVIGATE_TIMEOUT_MS = 4000;

/**
 * Some Framer API calls appear to never resolve or reject for certain node
 * states (e.g. nodes that only exist inside a component's internal
 * definition) rather than cleanly rejecting — without a timeout, an `await`
 * on one of those hangs forever with no visible error. Racing against a
 * timeout converts that silent hang into a normal, catchable failure.
 */
const withTimeout = async <T,>(
  promise: Promise<T>,
  label: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      // oxlint-disable-next-line promise/avoid-new
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`${label} timed out after ${NAVIGATE_TIMEOUT_MS}ms`)
          );
        }, NAVIGATE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Replica nodes (inside component instances) have unstable ids — walk up to
 * the nearest stable ancestor before navigating or mutating.
 */
const resolveStableCanvasNodeId = async (
  nodeId: string
): Promise<string | null> => {
  try {
    let currentNode = await withTimeout(framer.getNode(nodeId), "getNode");
    let depth = 0;
    // Each step depends on the previous node's parent, so this cannot be
    // parallelized — it's a sequential ancestor climb, not a batch of
    // independent lookups.
    while (currentNode?.isReplica && depth < 12) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      currentNode = await withTimeout(currentNode.getParent(), "getParent");
      depth += 1;
    }
    return currentNode?.id ?? null;
  } catch {
    return null;
  }
};

const MAX_RUNTIME_ERROR_CHECKS = 250;

/**
 * Framer exposes per-instance runtime errors behind `getRuntimeError()` on
 * ComponentInstanceNode (permission "ComponentInstanceNode.getRuntimeError"),
 * but the method is not in the published typings yet — feature-detect it.
 */
const collectInstanceRuntimeErrors = async (
  nodes: { id: string; componentName: string | null }[]
): Promise<InstanceRuntimeError[]> => {
  const errors: InstanceRuntimeError[] = [];

  // Sequential on purpose: bails out entirely on the first node where the
  // feature isn't available (typical case), and caps total API calls —
  // parallelizing would fire up to MAX_RUNTIME_ERROR_CHECKS requests at
  // once instead of stopping early.
  for (const node of nodes.slice(0, MAX_RUNTIME_ERROR_CHECKS)) {
    const candidate = node as {
      id: string;
      componentName: string | null;
      getRuntimeError?: () => Promise<
        { type?: string; message?: string } | string | null
      >;
    };
    if (typeof candidate.getRuntimeError !== "function") {
      return errors;
    }

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const result = await candidate.getRuntimeError();
      if (!result) {
        continue;
      }
      const message =
        typeof result === "string"
          ? result
          : (result.message ?? "Unknown runtime error");
      errors.push({
        componentName: candidate.componentName,
        message,
        nodeId: candidate.id,
      });
    } catch {
      // Best-effort: a failed lookup must not break the scan.
    }
  }

  return errors;
};

const scanRemoteImportsSnapshot = async (
  seedUrls: string[],
  codeFileNames: string[],
  instances: {
    id: string;
    insertURL: string | null;
    componentName?: string | null;
    componentIdentifier?: string | null;
  }[]
) => {
  const moduleScanResult = await scanModuleUrlsForFramerLocal(seedUrls, {
    codeFileNames,
    maxTotalFetches: 1200,
  });
  const framerFiles = await framer.getCodeFiles();
  const codeHits = scanCodeFileSourcesForFramerLocal(
    framerFiles.map((file) => ({
      content: file.content,
      name: file.name,
      path: file.path,
    }))
  );

  const report = formatFramerLocalScanReport({
    codeHits,
    instances,
    maxTotalFetches: moduleScanResult.maxTotalFetches,
    moduleScans: moduleScanResult.scans,
    projectNodeBaseUrl: deriveProjectNodeBaseUrl(),
    remainingQueue: moduleScanResult.remainingQueue,
    seedCount: seedUrls.length,
    truncated: moduleScanResult.truncated,
  });

  const hasIssues =
    moduleScanResult.scans.some(
      (scan) => scan.missing.length > 0 || !scan.ok || Boolean(scan.error)
    ) ||
    codeHits.some((hit) => hit.missing.length > 0 || hit.locals.length > 0);

  return {
    codeHits,
    fetchCount: moduleScanResult.scans.length,
    hasIssues,
    moduleScans: moduleScanResult.scans,
    report,
    truncated: moduleScanResult.truncated,
  };
};

const scanCodeFileIntegritySnapshot = async (
  moduleScans: Awaited<
    ReturnType<typeof scanModuleUrlsForFramerLocal>
  >["scans"],
  instances: {
    id: string;
    insertURL: string | null;
    componentName?: string | null;
  }[]
) => {
  const files = await framer.getCodeFiles();
  const issues = findCodeFilePathDriftIssues({
    files: files.map((file) => ({
      content: file.content,
      id: file.id,
      name: file.name,
      path: file.path,
    })),
    instances,
    moduleScans,
  });

  return {
    files,
    hasIssues: issues.length > 0,
    issues,
    report: formatCodeFilePathDriftReport(issues),
  };
};

const nodeSizeValue = (
  node: object | null | undefined,
  key: "height" | "width"
): unknown => {
  if (!node) {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const attributes = record.attributes as Record<string, unknown> | undefined;
  return record[key] ?? attributes?.[key];
};

/**
 * Replica nodes exist per non-primary breakpoint/variant and inherit every
 * attribute from the primary node unless specifically overridden — so
 * scanning them alongside the primary both double(-triple-, quadruple-)
 * counts the same design element once per breakpoint/variant copy, and
 * can report an inherited-but-not-actually-applied value when a replica's
 * override lives somewhere our read of it doesn't fully resolve. Checking
 * only the primary copy avoids both problems.
 */
const excludeReplicaNodes = <T extends { isReplica: boolean }>(
  nodes: T[]
): T[] => nodes.filter((node) => !node.isReplica);

/**
 * Framer colors are plain strings OR ColorStyle objects whose `.light` holds
 * an rgba string. Only accepting strings silently dropped every color-style
 * usage, which is why contrast checks never found pairs.
 */
const resolveColorValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as { light?: unknown };
    if (typeof record.light === "string") {
      return record.light;
    }
  }
  return null;
};

const getNodeTextIfAvailable = async (node: {
  getText?: () => Promise<string | null | undefined>;
}): Promise<string | null> => {
  if (typeof node.getText !== "function") {
    return null;
  }

  try {
    return (await node.getText()) ?? null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("not a text node")
    ) {
      return null;
    }
    throw error;
  }
};

const collectLayoutDriftInput = async () => {
  const [rawInstances, rawTextNodes] = await Promise.all([
    framer.getNodesWithType("ComponentInstanceNode"),
    framer.getNodesWithType("TextNode"),
  ]);
  const instances = excludeReplicaNodes(rawInstances);
  const textNodes = excludeReplicaNodes(rawTextNodes);

  const rows = [];
  for (const instance of instances) {
    rows.push({
      componentIdentifier: instance.componentIdentifier,
      componentName: instance.componentName,
      height: nodeSizeValue(instance, "height"),
      id: instance.id,
      name: instance.name,
      type: "ComponentInstanceNode",
      width: nodeSizeValue(instance, "width"),
    });
  }

  // Sequential on purpose: reading text from every node via the Framer
  // plugin bridge doesn't tolerate a burst of concurrent requests well.
  for (const node of textNodes) {
    rows.push({
      height: nodeSizeValue(node, "height"),
      id: node.id,
      name: node.name,
      // oxlint-disable-next-line eslint/no-await-in-loop
      text: await getNodeTextIfAvailable(node),
      type: "TextNode",
      width: nodeSizeValue(node, "width"),
    });
  }

  return rows;
};

const nearestBackgroundColor = async (node: {
  id: string;
}): Promise<string | null> => {
  let parent = await framer.getParent(node.id);

  // Each step depends on the previous node's parent, so this must stay
  // sequential — it's a single ancestor climb, not independent lookups.
  while (parent) {
    const backgroundColor = resolveColorValue(
      (parent as { backgroundColor?: unknown }).backgroundColor
    );
    if (backgroundColor) {
      return backgroundColor;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    parent = await framer.getParent(parent.id);
  }

  return null;
};

const collectCollectionItemIds = async (): Promise<string[] | undefined> => {
  try {
    const collections = await framer.getCollections();
    const ids: string[] = [];
    // Sequential on purpose: the Framer plugin bridge doesn't tolerate a
    // burst of concurrent requests well.
    for (const collection of collections) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const items = await collection.getItems();
      for (const item of items) {
        ids.push(item.id);
      }
    }
    return ids;
  } catch {
    // CMS access can fail (permissions, no collections); skip item validation.
    return undefined;
  }
};

const collectLinkCandidates = (
  frameLinks: { id: string; name: string | null; link?: unknown }[],
  textLinks: { id: string; name: string | null; link: unknown }[],
  instances: {
    id: string;
    componentName: string | null;
    controls?: unknown;
  }[]
): LinkCandidate[] => {
  const links: LinkCandidate[] = [];

  for (const node of frameLinks) {
    const rawLink = (node as { link?: unknown }).link;
    const href = extractHref(rawLink);
    const webPageLink = extractWebPageLink(rawLink);
    if (!href && !webPageLink) {
      continue;
    }
    links.push({
      canClearLink: true,
      nodeId: node.id,
      source: node.name ?? "Linked node",
      value: webPageLink ? rawLink : href,
    });
  }

  for (const node of textLinks) {
    const href = extractHref(node.link);
    const webPageLink = extractWebPageLink(node.link);
    if (!href && !webPageLink) {
      continue;
    }
    links.push({
      canClearLink: true,
      nodeId: node.id,
      source: node.name ?? "Linked text",
      value: webPageLink ? node.link : href,
    });
  }

  for (const instance of instances) {
    const { controls } = instance as { controls?: unknown };
    links.push(
      ...findLinkLikeValues(
        controls,
        instance.componentName ?? "Component",
        instance.id
      )
    );
  }

  return links;
};

const collectTextAndContrastCandidates = async (
  textNodes: {
    id: string;
    name: string | null;
    getText?: () => Promise<string | null | undefined>;
    inlineTextStyle?: unknown;
  }[]
): Promise<{ texts: TextCandidate[]; contrastPairs: ContrastCandidate[] }> => {
  const texts: TextCandidate[] = [];
  const contrastPairs: ContrastCandidate[] = [];

  // Sequential on purpose: reading text and climbing the ancestor chain for
  // every node via the Framer plugin bridge doesn't tolerate a burst of
  // concurrent requests well.
  for (const node of textNodes) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const text = await getNodeTextIfAvailable(node);
    const foreground = resolveColorValue(
      (node.inlineTextStyle as { color?: unknown } | null)?.color
    );
    // oxlint-disable-next-line eslint/no-await-in-loop
    const background = await nearestBackgroundColor(node);
    const label = node.name ?? text?.trim().slice(0, 40) ?? "Text";
    if (text?.trim()) {
      texts.push({
        nodeId: node.id,
        source: label,
        text,
      });
    }

    if (foreground && background) {
      contrastPairs.push({
        background,
        foreground,
        nodeId: node.id,
        source: label,
        text: text ?? undefined,
      });
    }
  }

  return { contrastPairs, texts };
};

const collectTeamPreflightInput = async () => {
  const [pages, rawFrameLinks, rawTextLinks, rawTextNodes, rawInstances] =
    await Promise.all([
      framer.getNodesWithType("WebPageNode"),
      framer.getNodesWithAttributeSet("link"),
      framer.getNodesWithType("TextNode"),
      framer.getNodesWithType("TextNode"),
      framer.getNodesWithType("ComponentInstanceNode"),
    ]);
  // Each breakpoint/variant replica of a repeated component would otherwise
  // surface the exact same link/text/contrast issue once per placement.
  const frameLinks = excludeReplicaNodes(rawFrameLinks);
  const textLinks = excludeReplicaNodes(rawTextLinks);
  const textNodes = excludeReplicaNodes(rawTextNodes);
  const instances = excludeReplicaNodes(rawInstances);
  const collectionItemIds = await collectCollectionItemIds();

  const pagePaths = pages
    .map((page) => page.path)
    .filter((path): path is string => Boolean(path));
  // Dynamic pages (CMS collection pages, "path variable" pages, etc.)
  // publish one URL per item under a templated path — Framer represents
  // that template literally, e.g. "/blog/:slug" — but the page node's own
  // `path` is just that template, so a real article's resolved URL
  // ("/blog/my-post") never matches `pagePaths` on its own and every link
  // to real content looks "broken".
  const dynamicPagePaths = pagePaths.filter((path) => path.includes(":"));
  const webPageIds = pages.map((page) => page.id);
  const links = collectLinkCandidates(frameLinks, textLinks, instances);
  const { contrastPairs, texts } =
    await collectTextAndContrastCandidates(textNodes);

  return {
    collectionItemIds,
    contrastPairs,
    dynamicPagePaths,
    links,
    pagePaths,
    texts,
    webPageIds,
  };
};

const checkExternalLinks = async (
  urls: string[]
): Promise<Map<string, ExternalLinkStatus>> => {
  const statuses = new Map<string, ExternalLinkStatus>();

  await Promise.all(
    urls.map(async (url) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);

      try {
        const response = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: controller.signal,
        });
        statuses.set(url, {
          ok: response.ok,
          status: response.status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(url, {
          ok: false,
          reason: message.includes("abort")
            ? "External link check timed out."
            : "Could not verify external link from the plugin.",
          unverified: !message.includes("abort"),
        });
      } finally {
        window.clearTimeout(timeout);
      }
    })
  );

  return statuses;
};

const checkSpelling = async (
  texts: TextCandidate[]
): Promise<SpellingIssue[]> => {
  const issues: SpellingIssue[] = [];
  const prose = texts
    .map((row) => ({ ...row, text: row.text.replaceAll(/\s+/gu, " ").trim() }))
    .filter((row) => row.text.length >= 12);

  // Sequential and rate-limited on purpose: this hits a shared third-party
  // API (LanguageTool), and stops entirely (break below) the first time it
  // fails rather than hammering it with 80 concurrent requests.
  for (const row of prose.slice(0, 80)) {
    const body = new URLSearchParams({
      language: "en-US",
      text: row.text,
    });

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const response = await fetch("https://api.languagetool.org/v2/check", {
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
      if (!response.ok) {
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop
      const payload = (await response.json()) as {
        matches?: {
          message?: string;
          offset?: number;
          length?: number;
          replacements?: { value?: string }[];
          rule?: { issueType?: string };
        }[];
      };

      for (const match of payload.matches ?? []) {
        if (match.rule?.issueType !== "misspelling") {
          continue;
        }
        const offset = match.offset ?? 0;
        const length = match.length ?? 0;
        issues.push({
          message: match.message ?? "Possible spelling issue",
          nodeId: row.nodeId,
          source: row.source,
          suggestions: (match.replacements ?? [])
            .map((replacement) => replacement.value)
            .filter((value): value is string => Boolean(value))
            .slice(0, 4),
          word: row.text.slice(offset, offset + length),
        });
      }
    } catch {
      issues.push({
        message: "LanguageTool could not be reached from the plugin.",
        nodeId: row.nodeId,
        source: row.source,
        suggestions: [],
        word: "(spellcheck unavailable)",
      });
      break;
    }
  }

  return issues;
};

const brokenComponentActions = (
  brokenComponentIssues: BrokenComponentIssue[]
): ViolationAction[] =>
  brokenComponentIssues.map((issue) => {
    const missingNames = issue.missingFilePaths.map(fileBasename).join(", ");
    return {
      category: "brokenComponent",
      description: issue.detail,
      fix:
        issue.missingFilePaths.length > 0
          ? {
              label: "Restore code file",
              type: "restoreMissingCodeFiles" as const,
            }
          : undefined,
      id: issue.id,
      insertURL: issue.insertURL ?? undefined,
      missingFilePaths: issue.missingFilePaths,
      nodeId: issue.nodeId,
      title: `Broken component: ${
        issue.componentName ??
        (missingNames ? `missing ${missingNames}` : "unknown component")
      }`,
    };
  });

const linkActions = (
  linkIssues: Awaited<ReturnType<typeof runTeamPreflight>>["linkIssues"]
): ViolationAction[] =>
  linkIssues.map((issue, index) => ({
    category: "link",
    description: `${issue.href || "(empty)"} - ${issue.reason}`,
    fix: issue.canClearLink
      ? {
          label: "Clear link",
          type: "clearLink" as const,
        }
      : undefined,
    id: `link-${index}-${issue.nodeId ?? "project"}`,
    nodeId: issue.nodeId,
    originalHref: issue.href || undefined,
    title: `${issue.severity.toUpperCase()} link: ${issue.source}`,
  }));

const punctuationActions = (
  punctuationIssues: Awaited<
    ReturnType<typeof runTeamPreflight>
  >["punctuationIssues"]
): ViolationAction[] =>
  punctuationIssues.map((issue, index) => ({
    category: "punctuation",
    description: `${issue.reason} ${issue.text}`,
    id: `punctuation-${index}-${issue.nodeId ?? "project"}`,
    nodeId: issue.nodeId,
    title: `Punctuation: ${issue.source}`,
  }));

const spellingActions = (
  spellingIssues: Awaited<ReturnType<typeof runTeamPreflight>>["spellingIssues"]
): ViolationAction[] =>
  spellingIssues.map((issue, index) => {
    const suggestions =
      issue.suggestions.length > 0
        ? ` Suggestions: ${issue.suggestions.join(", ")}`
        : "";
    return {
      category: "spelling",
      description: `${issue.word} - ${issue.message}.${suggestions}`,
      id: `spelling-${index}-${issue.nodeId ?? "project"}`,
      nodeId: issue.nodeId,
      title: `Spelling: ${issue.source}`,
    };
  });

const contrastActions = (
  contrastIssues: Awaited<ReturnType<typeof runTeamPreflight>>["contrastIssues"]
): ViolationAction[] =>
  contrastIssues.map((issue, index) => ({
    category: "contrast",
    description: `${issue.foreground} on ${issue.background} = ${issue.ratio.toFixed(2)}:1; needs ${issue.requiredRatio}:1.`,
    id: `contrast-${index}-${issue.nodeId ?? "project"}`,
    nodeId: issue.nodeId,
    originalBackground: issue.background,
    originalForeground: issue.foreground,
    title: `Contrast: ${issue.source}`,
  }));

const pathDriftActions = (
  pathDriftIssues: Awaited<ReturnType<typeof findCodeFilePathDriftIssues>>
): ViolationAction[] =>
  pathDriftIssues.map((issue, index) => {
    const firstInstanceId = issue.referencedBy
      .flatMap((reference) => reference.instanceIds)
      .at(0);
    return {
      category: "pathDrift",
      codeFileContent: issue.content,
      codeFileId: issue.id,
      codeFileName: issue.name,
      description: `${issue.path} is referenced by external module code but no root ${issue.expectedRootPath} code file exists.`,
      fix: {
        label: "Move to root",
        type: "moveToRoot" as const,
      },
      id: `path-drift-${index}-${issue.id}`,
      nodeId: firstInstanceId,
      title: `Code file path drift: ${issue.name}`,
    };
  });

const layoutDriftActions = (
  layoutDriftIssues: LayoutDriftIssue[]
): ViolationAction[] =>
  layoutDriftIssues.map((issue) => ({
    category: "layoutDrift",
    description: issue.reason,
    id: issue.id,
    nodeId: issue.nodeId,
    title: issue.title,
  }));

const brokenImportActions = (
  brokenRelativeImports: CodeHealthReport["brokenRelativeImports"],
  framerFileIdByPath: Map<string, string>
): ViolationAction[] =>
  brokenRelativeImports.map((issue, index) => {
    const fileId = framerFileIdByPath.get(issue.fromFile.toLowerCase());
    return {
      category: "brokenImport",
      codeFileId: fileId,
      codeFileName: issue.fromFile,
      description: `${issue.specifier} → ${issue.resolvedPath} not found in project.`,
      id: `broken-import-${index}`,
      title: `Broken import: ${fileBasename(issue.fromFile)}`,
    };
  });

const nestedLinkActions = (
  nestedLinks: CodeHealthReport["nestedLinks"],
  framerFileIdByPath: Map<string, string>
): ViolationAction[] =>
  nestedLinks.map((issue, index) => {
    const fileId = framerFileIdByPath.get(issue.file.toLowerCase());
    return {
      category: "nestedLink",
      codeFileId: fileId,
      codeFileName: issue.file,
      description: `Line ${issue.line}: <${issue.innerTag}> inside <${issue.outerTag}> — ${issue.snippet}`,
      id: `nested-link-${index}`,
      title: `Nested link: ${fileBasename(issue.file)}`,
    };
  });

const codeBundleHitActions = (
  codeHits: CodeFileBundleHit[],
  framerFileIdByPath: Map<string, string>
): ViolationAction[] =>
  codeHits.map((hit, index) => {
    const fileId = framerFileIdByPath.get(hit.path.toLowerCase());
    const details = [
      hit.missing.length > 0 ? `!missing: ${hit.missing.join(", ")}` : "",
      hit.locals.length > 0 ? `#framer/local: ${hit.locals.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      category: "codeBundle",
      codeFileId: fileId,
      codeFileName: hit.path,
      description: details,
      id: `code-bundle-hit-${index}`,
      title: `Bundle import issue: ${fileBasename(hit.path)}`,
    };
  });

const buildViolationActions = (
  teamReport: Awaited<ReturnType<typeof runTeamPreflight>>,
  pathDriftIssues: Awaited<ReturnType<typeof findCodeFilePathDriftIssues>>,
  layoutDriftIssues: LayoutDriftIssue[],
  brokenComponentIssues: BrokenComponentIssue[],
  codeHealthReport: CodeHealthReport,
  codeHits: CodeFileBundleHit[],
  /** Map from normalised file path (lowercase) to Framer code file ID */
  framerFileIdByPath: Map<string, string>
): ViolationAction[] => [
  ...brokenComponentActions(brokenComponentIssues),
  ...linkActions(teamReport.linkIssues),
  ...punctuationActions(teamReport.punctuationIssues),
  ...spellingActions(teamReport.spellingIssues),
  ...contrastActions(teamReport.contrastIssues),
  ...pathDriftActions(pathDriftIssues),
  ...layoutDriftActions(layoutDriftIssues),
  ...brokenImportActions(
    codeHealthReport.brokenRelativeImports,
    framerFileIdByPath
  ),
  ...nestedLinkActions(codeHealthReport.nestedLinks, framerFileIdByPath),
  ...codeBundleHitActions(codeHits, framerFileIdByPath),
];

const MAX_LOCATION_LOOKUPS = 150;
const MAX_LOCATION_CLIMB_DEPTH = 30;

interface NodeLocationInfo {
  pageName?: string;
  componentName?: string;
  layerName?: string;
}

/**
 * Best-effort page/component/layer breadcrumb for a node, resolved by
 * climbing the ancestor chain. Many broken-link/broken-component violations
 * live on replica nodes the plugin can't navigate to directly (see
 * `tryNavigateToNode`); this gives users something to search for in the
 * Layers panel by hand even when "Go to" can't reach the node itself.
 */
const describeNodeLocation = async (
  nodeId: string
): Promise<NodeLocationInfo | null> => {
  try {
    let current = await framer.getNode(nodeId);
    if (!current) {
      return null;
    }

    const info: NodeLocationInfo = {};
    const startName = (current as { name?: string | null }).name;
    if (startName) {
      info.layerName = startName;
    }

    let depth = 0;
    // Sequential on purpose: climbing the ancestor chain via the Framer
    // plugin bridge doesn't tolerate a burst of concurrent requests well.
    while (current && depth < MAX_LOCATION_CLIMB_DEPTH) {
      if (isWebPageNode(current)) {
        info.pageName = current.path ?? undefined;
        break;
      }
      if (isDesignPageNode(current)) {
        info.pageName = current.name ?? undefined;
        break;
      }
      if (!info.componentName && depth > 0) {
        const candidateName = (current as { componentName?: string | null })
          .componentName;
        if (candidateName) {
          info.componentName = candidateName;
        }
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      current = await current.getParent();
      depth += 1;
    }

    return info.pageName || info.componentName || info.layerName ? info : null;
  } catch {
    return null;
  }
};

const formatNodeLocation = (info: NodeLocationInfo): string => {
  const parts: string[] = [];
  if (info.pageName) {
    parts.push(`page "${info.pageName}"`);
  }
  if (info.componentName) {
    parts.push(`inside "${info.componentName}"`);
  }
  if (info.layerName) {
    parts.push(`layer "${info.layerName}"`);
  }
  return parts.join(" · ");
};

/**
 * Resolves a page/component/layer breadcrumb for every unique nodeId among
 * `actions`, capped at MAX_LOCATION_LOOKUPS so a project with an unusually
 * large number of violations doesn't stall the scan indefinitely.
 */
const enrichViolationLocations = async (
  actions: ViolationAction[]
): Promise<ViolationAction[]> => {
  const uniqueNodeIds = [
    ...new Set(
      actions
        .map((action) => action.nodeId)
        .filter((id): id is string => Boolean(id))
    ),
  ].slice(0, MAX_LOCATION_LOOKUPS);

  const locations = new Map<string, NodeLocationInfo>();
  // Sequential on purpose: the Framer plugin bridge doesn't tolerate a
  // burst of concurrent requests well.
  for (const nodeId of uniqueNodeIds) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const info = await describeNodeLocation(nodeId);
    if (info) {
      locations.set(nodeId, info);
    }
  }

  return actions.map((action) => {
    const info = action.nodeId ? locations.get(action.nodeId) : undefined;
    return info ? { ...action, location: formatNodeLocation(info) } : action;
  });
};

type ActionsUpdater = (
  updater: (current: ViolationAction[]) => ViolationAction[]
) => void;

const noteViolation = (
  setViolationActions: ActionsUpdater,
  actionId: string,
  note: string
) => {
  setViolationActions((current) =>
    current.map((row) => (row.id === actionId ? { ...row, note } : row))
  );
};

const removeViolation = (
  setViolationActions: ActionsUpdater,
  actionId: string
) => {
  setViolationActions((current) =>
    current.filter((row) => row.id !== actionId)
  );
};

/**
 * Best-effort climb from `nodeId` up to 12 ancestors, navigating to the
 * first one Framer will actually let the plugin select. Recursive rather
 * than a while-loop so each attempt's success/failure path stays simple.
 */
const climbToReachableAncestor = async (
  nodeId: string,
  depth: number,
  action: ViolationAction,
  trace: string[]
): Promise<boolean> => {
  if (depth >= 12) {
    trace.push("gave up after climbing 12 ancestors");
    return false;
  }

  try {
    await withTimeout(
      framer.navigateTo(nodeId, { select: true, zoomIntoView: { maxZoom: 1 } }),
      "navigateTo"
    );
    framer.notify(
      `Navigated to the nearest reachable container. "${action.title}" is inside — select the element to inspect or edit it.`,
      { variant: "info" }
    );
    return true;
  } catch (error) {
    trace.push(`navigateTo ancestor: ${describeError(error)}`);
    let parent: Awaited<ReturnType<typeof framer.getParent>>;
    try {
      parent = await withTimeout(framer.getParent(nodeId), "getParent");
    } catch (parentError) {
      trace.push(`getParent: ${describeError(parentError)}`);
      return false;
    }
    if (!parent) {
      trace.push("reached the top of the tree with no reachable ancestor");
      return false;
    }
    return climbToReachableAncestor(parent.id, depth + 1, action, trace);
  }
};

const tryNavigateToCodeFile = async (
  action: ViolationAction
): Promise<boolean> => {
  if (!(action.codeFileId && !action.nodeId && !action.insertURL)) {
    return false;
  }

  try {
    const files = await framer.getCodeFiles();
    const file = files.find((f) => f.id === action.codeFileId);
    if (file) {
      await file.navigateTo();
      return true;
    }
  } catch {
    // fall through to warning
  }
  framer.notify(
    `${action.title}: code file not found — it may have been deleted or renamed.`,
    { variant: "warning" }
  );
  return true;
};

const tryNavigateToNode = async (
  action: ViolationAction,
  trace: string[]
): Promise<boolean> => {
  if (!action.nodeId) {
    return false;
  }

  // Resolve replicas to their stable ancestor, then navigate via the
  // top-level API — it works across canvas scopes where getNode fails.
  const stableNodeId = await resolveStableCanvasNodeId(action.nodeId);
  const targetId = stableNodeId ?? action.nodeId;

  try {
    await withTimeout(
      framer.navigateTo(targetId, {
        select: true,
        zoomIntoView: { maxZoom: 1 },
      }),
      "navigateTo"
    );
    return true;
  } catch (error) {
    trace.push(`navigateTo: ${describeError(error)}`);
  }

  try {
    const parent = await withTimeout(framer.getParent(targetId), "getParent");
    if (parent) {
      return await climbToReachableAncestor(parent.id, 0, action, trace);
    }
    trace.push("no parent to climb to");
  } catch (error) {
    trace.push(`getParent: ${describeError(error)}`);
  }

  return false;
};

const tryNavigateToInsertURL = async (
  action: ViolationAction,
  trace: string[]
): Promise<boolean> => {
  if (!action.insertURL) {
    return false;
  }

  try {
    const instances = await framer.getNodesWithType("ComponentInstanceNode");
    const match = instances.find(
      (instance) => instance.insertURL === action.insertURL
    );
    const stableNodeId = match
      ? await resolveStableCanvasNodeId(match.id)
      : null;
    if (stableNodeId) {
      await withTimeout(
        framer.navigateTo(stableNodeId, {
          select: true,
          zoomIntoView: { maxZoom: 1 },
        }),
        "navigateTo"
      );
      return true;
    }
    trace.push("no live instance found matching this insertURL");
  } catch (error) {
    trace.push(`insertURL lookup: ${describeError(error)}`);
  }
  return false;
};

// Every violation title follows "<Category>: <name>" (optionally with a
// " controls.<prop>" suffix for instance-control links) — pull the layer/
// component name back out so it can be used as a search term, both in
// guidance text and to re-locate the node by name across the whole project.
const extractLayerNameHint = (title: string): string =>
  title
    .replace(/^[^:]+:\s*/u, "")
    .split(/\s+controls\./u)
    .at(0)
    ?.trim() ?? "";

/**
 * The Layers panel's own search doesn't reach across the whole project, so
 * "go search for it yourself" often isn't actually actionable. This does
 * what a project-wide asset-search plugin would do: query every searchable
 * node type (each a single bulk call, not one call per node) and match by
 * name. `getNodesWithType` is individually overloaded per literal type
 * (not generic over a union), so each type is called out explicitly rather
 * than looped over.
 */
const findNodesByNameAcrossProject = async (
  name: string
): Promise<{ id: string }[]> => {
  const trimmed = name.trim();
  if (!trimmed) {
    return [];
  }

  const queries: Promise<{ id: string; name: string | null }[]>[] = [
    framer.getNodesWithType("FrameNode"),
    framer.getNodesWithType("TextNode"),
    framer.getNodesWithType("SVGNode"),
    framer.getNodesWithType("ComponentInstanceNode"),
  ];
  const results = await Promise.allSettled(
    queries.map((query) => withTimeout(query, "getNodesWithType"))
  );

  const matches: { id: string }[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    for (const node of result.value) {
      if ((node.name ?? "").trim() === trimmed) {
        matches.push({ id: node.id });
      }
    }
  }
  return matches;
};

const tryNavigateByProjectSearch = async (
  action: ViolationAction,
  trace: string[]
): Promise<boolean> => {
  const nameHint = extractLayerNameHint(action.title);
  if (!nameHint) {
    return false;
  }

  const matches = await findNodesByNameAcrossProject(nameHint);
  if (matches.length === 0) {
    trace.push(`project search: no node named "${nameHint}" found`);
    return false;
  }

  const [first] = matches;
  try {
    await withTimeout(
      framer.navigateTo(first.id, {
        select: true,
        zoomIntoView: { maxZoom: 1 },
      }),
      "navigateTo"
    );
    framer.notify(
      matches.length > 1
        ? `Found ${matches.length} elements named "${nameHint}" — navigated to the first. Check the selection if this isn't the right one.`
        : `Found "${nameHint}" and navigated to it.`,
      { variant: "success" }
    );
    return true;
  } catch (error) {
    trace.push(`project search navigateTo: ${describeError(error)}`);
    return false;
  }
};

const buildCannotNavigateNote = (
  action: ViolationAction,
  trace: string[]
): string => {
  const nameHint = extractLayerNameHint(action.title);
  const isLinkCategory =
    action.category === "link" || action.category === "nestedLink";
  const propHint = action.title.includes("controls.")
    ? action.title.split("controls.").at(1)?.split(/\s/u)[0]
    : undefined;

  let fixAction = "fix the issue described above";
  if (isLinkCategory) {
    fixAction = propHint ? `clear the "${propHint}" link` : "remove the link";
  }

  const guidance = nameHint
    ? `Search the Layers panel for "${nameHint}", double-click to enter it, then ${fixAction} in the Properties panel.`
    : `Find the element in the Layers panel, double-click to enter it, then ${fixAction} in the Properties panel.`;

  const uniqueTrace = [...new Set(trace)];
  const debugSuffix =
    uniqueTrace.length > 0 ? ` [Details: ${uniqueTrace.join(" | ")}]` : "";

  return `Not directly navigable — the plugin couldn't reach it directly or find it by name project-wide. ${guidance}${debugSuffix}`;
};

const notifyCannotNavigate = (
  action: ViolationAction,
  setViolationActions: ActionsUpdater,
  trace: string[]
) => {
  const note = buildCannotNavigateNote(action, trace);
  framer.notify(
    `"${action.title}" could not be found — it may be inside a component or template the plugin can't reach.`,
    { variant: "warning" }
  );
  noteViolation(setViolationActions, action.id, note);
};

const goToViolation = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  if (await tryNavigateToCodeFile(action)) {
    return;
  }

  if (!action.nodeId && !action.insertURL) {
    framer.notify("This violation is not tied to a canvas node.", {
      variant: "info",
    });
    return;
  }

  const trace: string[] = [];

  if (await tryNavigateToNode(action, trace)) {
    return;
  }

  if (await tryNavigateToInsertURL(action, trace)) {
    return;
  }

  if (await tryNavigateByProjectSearch(action, trace)) {
    return;
  }

  notifyCannotNavigate(action, setViolationActions, trace);
};

const restoreMissingCodeFiles = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
) => {
  const paths = action.missingFilePaths ?? [];
  const existingFiles = await framer.getCodeFiles();

  const needsSyncFiles = paths.some((expectedPath) => {
    const base = fileBasename(expectedPath);
    const alreadyExists = existingFiles.some(
      (file) => file.path === expectedPath
    );
    const hasLocalContent = existingFiles.some((file) => file.name === base);
    return !(alreadyExists || hasLocalContent);
  });

  let syncFiles: DirectSyncFile[] = [];
  if (needsSyncFiles) {
    try {
      const response = await fetch("/__repo/framer-sync-files");
      const payload = (await response.json()) as { files?: DirectSyncFile[] };
      syncFiles = payload.files ?? [];
    } catch {
      syncFiles = [];
    }
  }

  const created: string[] = [];
  const problems: string[] = [];

  // Sequential on purpose: creating files one at a time via the Framer
  // plugin bridge doesn't tolerate a burst of concurrent requests well.
  for (const expectedPath of paths) {
    const base = fileBasename(expectedPath);
    if (existingFiles.some((file) => file.path === expectedPath)) {
      problems.push(
        `${base} already exists at ${expectedPath} — republish the component instead.`
      );
      continue;
    }

    // Prefer an existing project code file with the same name (it was
    // likely moved); fall back to the repo's generated sync source.
    const content =
      existingFiles.find((file) => file.name === base)?.content ??
      syncFiles.find((file) => fileBasename(file.syncPath) === base)?.content ??
      null;
    if (!content) {
      problems.push(
        `${base}: no source found in the project or repo sync files.`
      );
      continue;
    }

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await framer.createCodeFile(expectedPath, content);
      created.push(expectedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${base}: ${message}`);
    }
  }

  framer.notify(
    [
      created.length > 0
        ? `Restored ${created.map(fileBasename).join(", ")} at the expected path(s). Republish the affected component to pick it up.`
        : "No code files were restored.",
      ...problems,
    ].join(" "),
    {
      variant:
        created.length > 0 && problems.length === 0 ? "success" : "warning",
    }
  );
  if (created.length > 0) {
    removeViolation(setViolationActions, action.id);
  }
};

const moveCodeFileToRoot = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
) => {
  if (!action.codeFileId || !action.codeFileName) {
    framer.notify("This fix is missing file information.", {
      variant: "error",
    });
    return;
  }

  const allFiles = await framer.getCodeFiles();
  const target = allFiles.find((f) => f.id === action.codeFileId);
  if (!target) {
    framer.notify("Code file no longer exists — re-run preflight to refresh.", {
      variant: "error",
    });
    return;
  }

  await target.rename(action.codeFileName);

  try {
    await target.navigateTo();
  } catch {
    // navigation after rename is non-critical
  }

  framer.notify(
    `Moved ${action.codeFileName} to the project root. Re-run preflight to verify.`,
    { variant: "success" }
  );
  removeViolation(setViolationActions, action.id);
};

const createRootCodeFileCopy = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
) => {
  if (!action.codeFileName || !action.codeFileContent) {
    framer.notify("This code-file fix is missing source content.", {
      variant: "error",
    });
    return;
  }

  const existingFiles = await framer.getCodeFiles();
  const existingRoot = existingFiles.find(
    (file) => file.path === action.codeFileName
  );
  const rootFile =
    existingRoot ??
    (await framer.createCodeFile(action.codeFileName, action.codeFileContent));
  const diagnostics = await rootFile.typecheck({ strict: true });

  if (action.nodeId) {
    const node = await framer.getNode(action.nodeId);
    await node?.navigateTo({ select: true, zoomIntoView: { maxZoom: 1 } });
  } else {
    await rootFile.navigateTo();
  }

  framer.notify(
    diagnostics.length > 0
      ? `Created root code file, but typecheck found ${diagnostics.length} issue(s).`
      : "Created root code file copy. Re-run preflight after relinking or republishing the affected component.",
    { variant: diagnostics.length > 0 ? "warning" : "success" }
  );
  removeViolation(setViolationActions, action.id);
};

/**
 * Re-locates a violation's node by id first, falling back to a project-wide
 * name search (same technique as `tryNavigateByProjectSearch`) so a stale
 * id from an earlier scan doesn't stop a recheck from finding a node that
 * genuinely still exists.
 *
 * IMPORTANT: returning `null` means "the plugin couldn't reach this node,"
 * not "this node no longer exists." Nodes inside component instances,
 * layout templates, or CMS templates are frequently unreachable by direct
 * id lookup even though they're completely real and still broken — callers
 * must never treat "not found" here as license to remove the violation.
 */
const resolveCurrentNodeForRecheck = async (
  action: ViolationAction
): Promise<{ id: string } | null> => {
  if (action.nodeId) {
    try {
      const node = await withTimeout(framer.getNode(action.nodeId), "getNode");
      if (node) {
        return { id: node.id };
      }
    } catch {
      // fall through to name search
    }
  }

  const nameHint = extractLayerNameHint(action.title);
  if (!nameHint) {
    return null;
  }
  const matches = await findNodesByNameAcrossProject(nameHint);
  return matches.at(0) ?? null;
};

const recheckLinkViolation = async (
  action: ViolationAction,
  nodeId: string,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  const node = await withTimeout(framer.getNode(nodeId), "getNode");
  if (!node) {
    framer.notify(
      `Couldn't verify "${action.title}" — the node isn't directly reachable right now. Left in the list.`,
      { variant: "info" }
    );
    return;
  }
  const currentHref = extractHref((node as { link?: unknown }).link);

  if (currentHref === (action.originalHref ?? null)) {
    framer.notify(`"${action.title}" is still present — nothing changed.`, {
      variant: "info",
    });
    return;
  }

  framer.notify(
    `"${action.title}" looks different now (was "${action.originalHref ?? "(empty)"}", now "${currentHref ?? "(empty)"}") — removing from the list. Run a full scan to confirm.`,
    { variant: "success" }
  );
  removeViolation(setViolationActions, action.id);
};

const recheckLayoutDriftViolation = async (
  action: ViolationAction,
  nodeId: string,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  const node = await withTimeout(framer.getNode(nodeId), "getNode");
  if (!node) {
    framer.notify(
      `Couldn't verify "${action.title}" — the node isn't directly reachable right now. Left in the list.`,
      { variant: "info" }
    );
    return;
  }
  const typedNode = node as {
    name?: string | null;
    componentName?: string | null;
    componentIdentifier?: string | null;
  };

  const stillAnIssue =
    findLayoutDriftIssues([
      {
        componentIdentifier: typedNode.componentIdentifier,
        componentName: typedNode.componentName,
        height: nodeSizeValue(node as object, "height"),
        id: nodeId,
        name: typedNode.name,
        text: await getNodeTextIfAvailable(
          node as { getText?: () => Promise<string | null | undefined> }
        ),
        type: "node",
        width: nodeSizeValue(node as object, "width"),
      },
    ]).length > 0;

  if (stillAnIssue) {
    framer.notify(`"${action.title}" is still an issue.`, {
      variant: "info",
    });
    return;
  }

  framer.notify(`"${action.title}" looks fixed now — removing from the list.`, {
    variant: "success",
  });
  removeViolation(setViolationActions, action.id);
};

const CONTRAST_REQUIRED_RATIO = 4.5;

const recheckContrastViolation = async (
  action: ViolationAction,
  nodeId: string,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  const node = await withTimeout(framer.getNode(nodeId), "getNode");
  if (!node) {
    framer.notify(
      `Couldn't verify "${action.title}" — the node isn't directly reachable right now. Left in the list.`,
      { variant: "info" }
    );
    return;
  }
  const foreground = resolveColorValue(
    (node as { inlineTextStyle?: { color?: unknown } | null }).inlineTextStyle
      ?.color
  );
  const background = await nearestBackgroundColor({ id: nodeId });
  const ratio =
    foreground && background ? contrastRatio(foreground, background) : null;

  const stillAnIssue = ratio !== null && ratio < CONTRAST_REQUIRED_RATIO;

  if (stillAnIssue) {
    framer.notify(
      `"${action.title}" is still an issue — ${foreground} on ${background} = ${(ratio as number).toFixed(2)}:1.`,
      { variant: "info" }
    );
    return;
  }

  const changed =
    foreground !== (action.originalForeground ?? null) ||
    background !== (action.originalBackground ?? null);
  framer.notify(
    changed
      ? `"${action.title}" looks fixed now (was ${action.originalForeground ?? "?"} on ${action.originalBackground ?? "?"}) — removing from the list.`
      : `"${action.title}" now passes contrast — removing from the list.`,
    { variant: "success" }
  );
  removeViolation(setViolationActions, action.id);
};

/**
 * Re-verifies a single violation without re-running the full project scan.
 * Link, layout-drift, and contrast violations get a real re-check against
 * the node's current state; other categories can only confirm the node
 * still exists (their underlying checks — spelling, code health, etc. —
 * need a broader scan to re-evaluate).
 */
const recheckViolation = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  try {
    const current = await resolveCurrentNodeForRecheck(action);
    if (!current) {
      framer.notify(
        `Couldn't verify "${action.title}" — it's not directly reachable by the plugin (common for elements inside components or templates). Left in the list; run a full scan to be sure.`,
        { variant: "info" }
      );
      return;
    }

    if (action.category === "link") {
      await recheckLinkViolation(action, current.id, setViolationActions);
      return;
    }

    if (action.category === "layoutDrift") {
      await recheckLayoutDriftViolation(
        action,
        current.id,
        setViolationActions
      );
      return;
    }

    if (action.category === "contrast") {
      await recheckContrastViolation(action, current.id, setViolationActions);
      return;
    }

    framer.notify(
      `"${action.title}" still exists. This category needs a full scan to re-check the underlying condition, so it's left in the list.`,
      { variant: "info" }
    );
  } catch (error) {
    framer.notify(`Could not recheck: ${describeError(error)}`, {
      variant: "error",
    });
  }
};

const clearViolationLink = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
) => {
  if (!action.nodeId || action.fix?.type !== "clearLink") {
    framer.notify("No automatic fix is available for this violation.", {
      variant: "info",
    });
    return;
  }

  const stableNodeId =
    (await resolveStableCanvasNodeId(action.nodeId)) ?? action.nodeId;

  try {
    await framer.setAttributes(stableNodeId, {
      link: null,
    } as unknown as Parameters<typeof framer.setAttributes>[1]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/not found/iu.test(msg)) {
      framer.notify(
        `"${action.title}" is inside a component or template — open it, select the element, and clear the link manually in the Properties panel.`,
        { variant: "warning" }
      );
      return;
    }
    throw error;
  }

  // Verify the clear actually took effect — Framer silently accepts
  // setAttributes calls on nodes in restricted scopes without applying them.
  const linkCleared = await (async () => {
    try {
      const node = await framer.getNode(stableNodeId);
      if (!node) {
        return false;
      }
      return !(node as { link?: unknown }).link;
    } catch {
      return false;
    }
  })();

  if (!linkCleared) {
    framer.notify(
      `Link still present on "${action.title}" — it's inside a component or template that the plugin can't write to directly. ` +
        "Find the element in the Layers panel, double-click to enter the component, then remove the link in the Properties panel.",
      { variant: "warning" }
    );
    noteViolation(
      setViolationActions,
      action.id,
      "Link still present — it's inside a component or template the plugin can't write to directly. Open it in the Layers panel and clear the link manually in the Properties panel."
    );
    return;
  }

  // Navigate after the fix is applied; a navigation failure is non-critical.
  try {
    await framer.navigateTo(stableNodeId, {
      select: true,
      zoomIntoView: { maxZoom: 1 },
    });
  } catch {
    // ignore
  }

  framer.notify("Cleared the broken link on the selected node.", {
    variant: "success",
  });
  removeViolation(setViolationActions, action.id);
};

const fixViolation = async (
  action: ViolationAction,
  setViolationActions: ActionsUpdater
): Promise<void> => {
  if (!action.fix) {
    framer.notify("No automatic fix is available for this violation.", {
      variant: "info",
    });
    return;
  }

  try {
    if (action.fix.type === "restoreMissingCodeFiles") {
      await restoreMissingCodeFiles(action, setViolationActions);
      return;
    }
    if (action.fix.type === "moveToRoot") {
      await moveCodeFileToRoot(action, setViolationActions);
      return;
    }
    if (action.fix.type === "createRootCodeFileCopy") {
      await createRootCodeFileCopy(action, setViolationActions);
      return;
    }
    await clearViolationLink(action, setViolationActions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    framer.notify(`Could not fix violation: ${message}`, {
      variant: "error",
    });
  }
};

const repairCodeFileNames = async (
  filesById: Map<string, CodeFileHandle>,
  repairs: OrganizePlan["codeFileNameRepairs"]
): Promise<{ repaired: number; failures: string[] }> => {
  let repaired = 0;
  const failures: string[] = [];

  // Sequential on purpose: renaming files one at a time via the Framer
  // plugin bridge doesn't tolerate a burst of concurrent requests well.
  for (const repair of repairs) {
    const file = filesById.get(repair.fileId);
    if (!file) {
      failures.push(`${repair.currentName}: code file no longer exists`);
      continue;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await file.rename(repair.restoredName);
      repaired += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${repair.currentName}: ${message}`);
    }
  }

  return { failures, repaired };
};

const applyCanvasFolderChanges = async (
  changedRows: OrganizeCanvasRow[],
  folderIndex: { folderNodeIdByPath: Map<string, string>; rootIds: string[] }
): Promise<{
  renamed: number;
  failures: string[];
  renameFallbacks: string[];
}> => {
  const { folderNodeIdByPath, rootIds } = folderIndex;
  let renamed = 0;
  const failures: string[] = [];
  const renameFallbacks: string[] = [];

  // Sequential on purpose: reparenting/renaming nodes one at a time via the
  // Framer plugin bridge doesn't tolerate a burst of concurrent requests
  // well.
  for (const row of changedRows) {
    try {
      const targetFolder = row.folder
        .trim()
        .replaceAll("\\", "/")
        .replaceAll(/^\/+|\/+$/gu, "");
      const folderNodeId = targetFolder
        ? folderNodeIdByPath.get(targetFolder)
        : undefined;

      if (targetFolder && folderNodeId) {
        // Real assets-panel folder: move the component node into it.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await framer.setParent(row.nodeId, folderNodeId);
        renamed += 1;
        continue;
      }

      if (!targetFolder && rootIds.length > 0) {
        // Cleared folder: move back to the design page root.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await framer.setParent(row.nodeId, rootIds[0]);
        renamed += 1;
        continue;
      }

      // Unknown folder: fall back to slash naming, which groups
      // name-prefix organized components.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const node = await framer.getNode(row.nodeId);
      const editable = node as {
        setAttributes?: (update: { name: string }) => Promise<unknown>;
      } | null;
      if (!editable || typeof editable.setAttributes !== "function") {
        throw new Error("component no longer exists");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await editable.setAttributes({
        name: componentNameForFolder(row.baseName, row.folder),
      });
      renamed += 1;
      renameFallbacks.push(
        `${row.baseName}: no existing folder node "${targetFolder}" — used a slash rename. If no folder appears in the assets panel, create the folder in Framer once and re-run.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${row.baseName}: ${message}`);
    }
  }

  return { failures, renameFallbacks, renamed };
};

interface PreflightSectionProps {
  scanning: boolean;
  onRunPreflight: () => void;
  teamOptions: TeamPreflightOptions;
  onToggleTeamOption: (key: OptionalCheckKey) => void;
  scanned: boolean;
  scanError: string | null;
  violationActions: ViolationAction[];
  onGoToViolation: (action: ViolationAction) => void;
  onFixViolation: (action: ViolationAction) => void;
  onRecheckViolation: (action: ViolationAction) => void;
}

const PreflightSection = ({
  scanning,
  onRunPreflight,
  teamOptions,
  onToggleTeamOption,
  scanned,
  scanError,
  violationActions,
  onGoToViolation,
  onFixViolation,
  onRecheckViolation,
}: PreflightSectionProps) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const [prevScanning, setPrevScanning] = useState(scanning);
  const [categoryFilter, setCategoryFilter] = useState<
    ViolationCategory | "all"
  >("all");
  const [prevCategoryFilter, setPrevCategoryFilter] = useState(categoryFilter);
  const [searchQuery, setSearchQuery] = useState("");
  const [prevSearchQuery, setPrevSearchQuery] = useState(searchQuery);

  // A fresh scan just started, or a filter changed — reset pagination back
  // to the first page so a filtered-down old list doesn't leave stale
  // results hidden. Adjusting state during render (rather than in an
  // effect) avoids the extra commit/render pass an effect would cause.
  if (scanning !== prevScanning) {
    setPrevScanning(scanning);
    if (scanning) {
      setCurrentPage(1);
    }
  }
  if (categoryFilter !== prevCategoryFilter) {
    setPrevCategoryFilter(categoryFilter);
    setCurrentPage(1);
  }
  if (searchQuery !== prevSearchQuery) {
    setPrevSearchQuery(searchQuery);
    setCurrentPage(1);
  }

  const categoryCounts = useMemo(() => {
    const counts = new Map<ViolationCategory, number>();
    for (const action of violationActions) {
      counts.set(action.category, (counts.get(action.category) ?? 0) + 1);
    }
    return [...counts.entries()].toSorted(([, a], [, b]) => b - a);
  }, [violationActions]);

  const filteredActions = useMemo(() => {
    const byCategory =
      categoryFilter === "all"
        ? violationActions
        : violationActions.filter(
            (action) => action.category === categoryFilter
          );
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return byCategory;
    }
    return byCategory.filter((action) =>
      [action.title, action.description, action.location, action.note]
        .filter(Boolean)
        .some((text) => text?.toLowerCase().includes(query))
    );
  }, [violationActions, categoryFilter, searchQuery]);

  const pageCount = Math.max(
    1,
    Math.ceil(filteredActions.length / VIOLATIONS_PAGE_SIZE)
  );
  // Filtering/searching can shrink the result set out from under the page
  // the user was on — clamp rather than showing an empty page.
  const clampedPage = Math.min(currentPage, pageCount);
  if (clampedPage !== currentPage) {
    setCurrentPage(clampedPage);
  }

  const pageStart = (clampedPage - 1) * VIOLATIONS_PAGE_SIZE;
  const visibleActions = filteredActions.slice(
    pageStart,
    pageStart + VIOLATIONS_PAGE_SIZE
  );

  const goToPage = (page: number) => {
    setCurrentPage(Math.min(Math.max(page, 1), pageCount));
  };

  return (
    <section className="panel">
      <div className="panel-topline">
        <span className="panel-label">Project cleanup scan</span>
        <button
          className="btn btn--primary btn--medium"
          disabled={scanning}
          onClick={onRunPreflight}
          type="button"
        >
          {scanning ? "Running…" : "Run full cleanup scan"}
        </button>
      </div>

      <div
        aria-label="Optional preflight checks"
        className="op-grid op-grid--2-column"
      >
        <label className="card card--padded">
          <input
            checked={teamOptions.checkExternalLinks}
            onChange={() => onToggleTeamOption("checkExternalLinks")}
            type="checkbox"
          />
          <p>
            <strong>Dead external links</strong>
          </p>
          <p>Slower; some hosts block browser verification.</p>
        </label>
        <label className="card card--padded">
          <input
            checked={teamOptions.checkColorContrast}
            onChange={() => onToggleTeamOption("checkColorContrast")}
            type="checkbox"
          />
          <p>
            <strong>Color contrast</strong>
          </p>
          <p>Checks text color against detected parent background.</p>
        </label>
        <label className="card card--padded">
          <input
            checked={teamOptions.checkSpelling}
            onChange={() => onToggleTeamOption("checkSpelling")}
            type="checkbox"
          />
          <p>
            <strong>Spelling</strong>
          </p>
          <p>Uses LanguageTool and sends scanned text for review.</p>
        </label>
        <label className="card card--padded">
          <input
            checked={teamOptions.checkPunctuation}
            onChange={() => onToggleTeamOption("checkPunctuation")}
            type="checkbox"
          />
          <p>
            <strong>Punctuation</strong>
          </p>
          <p>Local checks for spacing, placeholders, and punctuation.</p>
        </label>
      </div>

      {!scanning && scanned && violationActions.length === 0 && (
        <p className="panel-muted">
          {scanError ? `Scan failed: ${scanError}` : "✓ All checks passed."}
        </p>
      )}

      {violationActions.length > 0 ? (
        <div aria-label="Actionable violations" className="violation-list">
          <div className="panel-topline">
            <span className="panel-label">
              {violationActions.length} actionable issue
              {violationActions.length === 1 ? "" : "s"}
            </span>
            <span className="panel-muted">Fix or navigate to each one.</span>
          </div>
          <input
            aria-label="Search violations"
            className="form-control form-control--small"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by title, description, page, component…"
            type="search"
            value={searchQuery}
          />
          <div aria-label="Filter by category" className="violation-filters">
            <button
              className={`btn btn--small${categoryFilter === "all" ? " btn--active" : ""}`}
              onClick={() => setCategoryFilter("all")}
              type="button"
            >
              All ({violationActions.length})
            </button>
            {categoryCounts.map(([category, count]) => (
              <button
                className={`btn btn--small${categoryFilter === category ? " btn--active" : ""}`}
                key={category}
                onClick={() => setCategoryFilter(category)}
                type="button"
              >
                {VIOLATION_CATEGORY_LABELS[category]} ({count})
              </button>
            ))}
          </div>
          {filteredActions.length === 0 ? (
            <p className="panel-muted">No violations match this search.</p>
          ) : null}
          {visibleActions.map((action) => (
            <article className="violation-card" key={action.id}>
              <div>
                <strong>{action.title}</strong>
                <span>{action.description}</span>
                {action.location ? (
                  <span className="panel-muted">{action.location}</span>
                ) : null}
                {action.note ? (
                  <span className="panel-muted">{action.note}</span>
                ) : null}
              </div>
              <div className="violation-card__actions">
                {(action.nodeId ?? action.insertURL ?? action.codeFileId) ? (
                  <button
                    className="btn btn--primary"
                    onClick={() => onGoToViolation(action)}
                    type="button"
                  >
                    Go to
                  </button>
                ) : null}
                {action.fix ? (
                  <button
                    className="btn btn--primary"
                    onClick={() => onFixViolation(action)}
                    type="button"
                  >
                    {action.fix.label}
                  </button>
                ) : null}
                <button
                  className="btn"
                  onClick={() => onRecheckViolation(action)}
                  type="button"
                >
                  Recheck
                </button>
              </div>
            </article>
          ))}
          {pageCount > 1 ? (
            <div aria-label="Pagination" className="violation-pagination">
              <span className="panel-muted">
                Showing {pageStart + 1}–{pageStart + visibleActions.length} of{" "}
                {filteredActions.length}
              </span>
              <div className="violation-pagination__controls">
                <button
                  className="btn btn--small"
                  disabled={clampedPage <= 1}
                  onClick={() => goToPage(clampedPage - 1)}
                  type="button"
                >
                  Previous
                </button>
                <span className="panel-muted">
                  Page {clampedPage} of {pageCount}
                </span>
                <button
                  className="btn btn--small"
                  disabled={clampedPage >= pageCount}
                  onClick={() => goToPage(clampedPage + 1)}
                  type="button"
                >
                  Next
                </button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const parsed = Math.trunc(Number(pageJumpValue));
                    if (Number.isFinite(parsed)) {
                      goToPage(parsed);
                    }
                    setPageJumpValue("");
                  }}
                >
                  <input
                    aria-label="Jump to page"
                    className="form-control form-control--small violation-pagination__jump"
                    min={1}
                    max={pageCount}
                    onChange={(event) => setPageJumpValue(event.target.value)}
                    placeholder="Go to…"
                    type="number"
                    value={pageJumpValue}
                  />
                </form>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

interface OrganizeSectionProps {
  organizeBusy: "preview" | "apply" | null;
  onPreview: () => void;
  onApply: () => void;
  organizeChangeCount: number;
  organizePlan: OrganizePlan | null;
  organizeCanvasRows: OrganizeCanvasRow[];
  onSetRowFolder: (nodeId: string, folder: string) => void;
  organizeStatus: string;
}

const OrganizeSection = ({
  organizeBusy,
  onPreview,
  onApply,
  organizeChangeCount,
  organizePlan,
  organizeCanvasRows,
  onSetRowFolder,
  organizeStatus,
}: OrganizeSectionProps) => {
  let applyLabel = "Apply";
  if (organizeBusy === "apply") {
    applyLabel = "Applying…";
  } else if (organizePlan) {
    applyLabel = `Apply ${organizeChangeCount} change(s)`;
  }

  const changedCount = organizeCanvasRows.filter(
    (row) => row.folder.trim() !== row.currentFolder
  ).length;

  return (
    <section className="panel">
      <div className="panel-topline">
        <span className="panel-label">Organize components into folders</span>
        <div className="header-actions">
          <button
            className="btn btn--medium"
            disabled={organizeBusy !== null}
            onClick={onPreview}
            type="button"
          >
            {organizeBusy === "preview" ? "Planning…" : "Preview plan"}
          </button>
          <button
            className="btn btn--primary btn--medium"
            disabled={organizeBusy !== null || organizeChangeCount === 0}
            onClick={onApply}
            type="button"
          >
            {applyLabel}
          </button>
        </div>
      </div>

      <p className="panel-muted">
        Project components can be grouped into folders — when a component
        matches your library we suggest one, otherwise pick a folder yourself
        below, or clear it to leave the component at the root. Code files
        can&apos;t be moved into folders by a plugin, so this only fixes any
        file names an earlier version of this feature corrupted while trying.
      </p>

      {organizeCanvasRows.length > 0 ? (
        <div
          aria-label="Project component folder assignments"
          className="violation-list"
        >
          <div className="panel-topline">
            <span className="panel-label">Project components</span>
            <span className="panel-muted">
              {changedCount} of {organizeCanvasRows.length} will change
            </span>
          </div>
          <datalist id="organize-folder-options">
            {(organizePlan?.folderOptions ?? []).map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </datalist>
          {organizeCanvasRows.map((row) => (
            <article className="violation-card" key={row.nodeId}>
              <div>
                <strong>
                  {row.currentFolder
                    ? `${row.currentFolder}/${row.baseName}`
                    : row.baseName}
                </strong>
                <span>{row.reason}</span>
              </div>
              <div className="organize-row__folder">
                <select
                  aria-label={`Folder for ${row.baseName}`}
                  className="form-control form-control--small"
                  onChange={(event) =>
                    onSetRowFolder(row.nodeId, event.target.value)
                  }
                  value={row.folder}
                >
                  <option value="">No folder (root)</option>
                  {(organizePlan?.folderOptions ?? []).map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <pre className="report">{organizeStatus}</pre>
    </section>
  );
};

interface SpacingSectionProps {
  templates: SpacingTemplate[];
  selectedTemplateId: string;
  onSelectTemplate: (id: string) => void;
  selectedTemplate: SpacingTemplate | undefined;
  applyingSpacing: string | null;
  onApplySpacing: (row: SpacingBreakpoint, templateName: string) => void;
  onChangeTemplate: (template: SpacingTemplate) => void;
  onCreateTemplate: () => void;
  onDeleteTemplate: () => void;
  onDuplicateTemplate: () => void;
  onSaveTemplates: () => void;
  storageStatus: string;
  savingTemplates: boolean;
}

const SpacingSection = ({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  selectedTemplate,
  applyingSpacing,
  onApplySpacing,
  onChangeTemplate,
  onCreateTemplate,
  onDeleteTemplate,
  onDuplicateTemplate,
  onSaveTemplates,
  storageStatus,
  savingTemplates,
}: SpacingSectionProps) => (
  <section className="panel">
    <div className="panel-topline">
      <div>
        <span className="panel-label">Spacing templates</span>
        <div className="panel-muted">
          Create reusable container spacing for mobile, tablet, and desktop.
          Templates are stored in this Framer project.
        </div>
      </div>
      <div className="header-actions">
        <button className="btn" onClick={onCreateTemplate} type="button">
          New
        </button>
        <button
          className="btn"
          disabled={!selectedTemplate}
          onClick={onDuplicateTemplate}
          type="button"
        >
          Duplicate
        </button>
        <button
          className="btn"
          disabled={!selectedTemplate}
          onClick={onDeleteTemplate}
          type="button"
        >
          Delete
        </button>
        <button
          className="btn btn--primary"
          disabled={savingTemplates}
          onClick={onSaveTemplates}
          type="button"
        >
          {savingTemplates ? "Saving…" : "Save templates"}
        </button>
      </div>
    </div>

    <p className="panel-muted">{storageStatus}</p>

    <div className="template-grid">
      {templates.map((template) => {
        const isSelected = template.id === selectedTemplateId;

        return (
          <article
            className={`template-card${isSelected ? " template-card--selected" : ""}`}
            key={template.id}
          >
            <button
              className="template-card__header"
              onClick={() => onSelectTemplate(template.id)}
              type="button"
            >
              <span>
                <strong>{template.name}</strong>
                <span>{template.description}</span>
              </span>
              <span className="template-card__badge">
                {isSelected ? "Selected" : "Use"}
              </span>
            </button>

            <div className="template-table">
              <div className="template-table__head">
                <span>Breakpoint</span>
                <span>Padding Y</span>
                <span>Padding X</span>
                <span>Gap</span>
                <span>Apply</span>
              </div>
              {template.breakpoints.map((row) => {
                const applyKey = `${template.name}-${row.breakpoint}`;
                const isApplying = applyingSpacing === applyKey;

                return (
                  <div className="template-table__row" key={row.breakpoint}>
                    <span>{row.breakpoint}</span>
                    <span>{row.paddingY}px</span>
                    <span>{row.paddingX}px</span>
                    <span>{row.gap}px</span>
                    <button
                      className="btn btn--primary"
                      disabled={applyingSpacing !== null}
                      onClick={() => onApplySpacing(row, template.name)}
                      type="button"
                    >
                      {isApplying ? "Applying" : "Apply"}
                    </button>
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>

    {selectedTemplate ? (
      <div className="panel">
        <div className="panel-label">Edit template</div>
        <div className="check-grid">
          <label>
            <span>Name</span>
            <input
              className="form-control"
              onChange={(event) =>
                onChangeTemplate({
                  ...selectedTemplate,
                  name: event.target.value,
                })
              }
              type="text"
              value={selectedTemplate.name}
            />
          </label>
          <label>
            <span>Description</span>
            <input
              className="form-control"
              onChange={(event) =>
                onChangeTemplate({
                  ...selectedTemplate,
                  description: event.target.value,
                })
              }
              type="text"
              value={selectedTemplate.description}
            />
          </label>
        </div>

        <div className="template-table">
          <div className="template-table__head">
            <span>Breakpoint</span>
            <span>Padding Y</span>
            <span>Padding X</span>
            <span>Gap</span>
            <span>Min width</span>
          </div>
          {selectedTemplate.breakpoints.map((row) => (
            <div className="template-table__row" key={row.breakpoint}>
              <strong>{row.breakpoint}</strong>
              {(["paddingY", "paddingX", "gap", "maxWidth"] as const).map(
                (field) => (
                  <input
                    aria-label={`${row.breakpoint} ${field}`}
                    className="form-control form-control--small"
                    key={field}
                    min={0}
                    onChange={(event) => {
                      const nextValue =
                        field === "maxWidth" && event.target.value === ""
                          ? null
                          : Number(event.target.value);
                      onChangeTemplate({
                        ...selectedTemplate,
                        breakpoints: selectedTemplate.breakpoints.map(
                          (breakpoint) =>
                            breakpoint.breakpoint === row.breakpoint
                              ? { ...breakpoint, [field]: nextValue }
                              : breakpoint
                        ),
                      });
                    }}
                    placeholder={field === "maxWidth" ? "Fluid" : undefined}
                    type="number"
                    value={row[field] ?? ""}
                  />
                )
              )}
            </div>
          ))}
        </div>

        <pre className="report report--compact">
          {formatSpacingTemplateSummary(selectedTemplate)}
        </pre>
      </div>
    ) : (
      <p className="panel-muted">
        No spacing templates yet. Create one to get started.
      </p>
    )}
  </section>
);

export const App = () => {
  const [section, setSection] = useState<ScanSection>("preflight");
  const [spacingTemplates, setSpacingTemplates] = useState<SpacingTemplate[]>(
    []
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    defaultSpacingTemplates[0]?.id ?? ""
  );
  const [applyingSpacing, setApplyingSpacing] = useState<string | null>(null);
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [spacingStorageStatus, setSpacingStorageStatus] = useState(
    "Loading saved templates…"
  );
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [teamOptions, setTeamOptions] = useState<TeamPreflightOptions>(
    DEFAULT_TEAM_PREFLIGHT_OPTIONS
  );
  const [violationActions, setViolationActions] = useState<ViolationAction[]>(
    []
  );
  const [organizePlan, setOrganizePlan] = useState<OrganizePlan | null>(null);
  const [organizeCanvasRows, setOrganizeCanvasRows] = useState<
    OrganizeCanvasRow[]
  >([]);
  const [organizeBusy, setOrganizeBusy] = useState<"preview" | "apply" | null>(
    null
  );
  const organizeFolderIndexRef = useRef<{
    folderNodeIdByPath: Map<string, string>;
    rootIds: string[];
  }>({ folderNodeIdByPath: new Map(), rootIds: [] });
  const [organizeStatus, setOrganizeStatus] = useState<string>(
    "Preview a plan to group code files and project components into folders."
  );

  const selectedTemplate = useMemo(
    () =>
      spacingTemplates.find((template) => template.id === selectedTemplateId) ??
      spacingTemplates[0],
    [selectedTemplateId, spacingTemplates]
  );

  useEffect(() => {
    const loadSpacingTemplates = async () => {
      try {
        const storedValue = await framer.getPluginData(
          SPACING_TEMPLATES_PLUGIN_DATA_KEY
        );
        const templates = parseSpacingTemplates(storedValue);
        setSpacingTemplates(templates);
        setSelectedTemplateId(templates[0]?.id ?? "");
        setSpacingStorageStatus(
          storedValue
            ? `Loaded ${templates.length} saved template(s).`
            : "Using the starter template. Save to store it in this project."
        );
      } catch (error) {
        setSpacingTemplates(parseSpacingTemplates(null));
        setSpacingStorageStatus(
          `Could not load saved templates: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
    void loadSpacingTemplates();
  }, []);

  const handleChangeSpacingTemplate = useCallback(
    (updatedTemplate: SpacingTemplate) => {
      setSpacingTemplates((templates) =>
        templates.map((template) =>
          template.id === updatedTemplate.id ? updatedTemplate : template
        )
      );
      setSpacingStorageStatus("Unsaved changes.");
    },
    []
  );

  const handleCreateSpacingTemplate = useCallback(() => {
    const template = createSpacingTemplate();
    setSpacingTemplates((templates) => [...templates, template]);
    setSelectedTemplateId(template.id);
    setSpacingStorageStatus("New template created. Save to keep it.");
  }, []);

  const handleDuplicateSpacingTemplate = useCallback(() => {
    if (!selectedTemplate) {
      return;
    }
    const template = createSpacingTemplate(selectedTemplate);
    setSpacingTemplates((templates) => [...templates, template]);
    setSelectedTemplateId(template.id);
    setSpacingStorageStatus("Template duplicated. Save to keep it.");
  }, [selectedTemplate]);

  const handleDeleteSpacingTemplate = useCallback(() => {
    if (!selectedTemplate) {
      return;
    }
    const remaining = spacingTemplates.filter(
      (template) => template.id !== selectedTemplate.id
    );
    setSpacingTemplates(remaining);
    setSelectedTemplateId(remaining[0]?.id ?? "");
    setSpacingStorageStatus("Template deleted. Save to confirm the change.");
  }, [selectedTemplate, spacingTemplates]);

  const handleSaveSpacingTemplates = useCallback(async () => {
    const hasInvalidTemplate = spacingTemplates.some(
      (template) => !template.name.trim()
    );
    if (hasInvalidTemplate) {
      setSpacingStorageStatus("Every template needs a name before saving.");
      return;
    }

    setSavingTemplates(true);
    try {
      await framer.setPluginData(
        SPACING_TEMPLATES_PLUGIN_DATA_KEY,
        JSON.stringify(spacingTemplates)
      );
      setSpacingStorageStatus(
        `Saved ${spacingTemplates.length} template(s) to this project.`
      );
      await framer.notify("Spacing templates saved.", { variant: "success" });
    } catch (error) {
      setSpacingStorageStatus(
        `Could not save templates: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSavingTemplates(false);
    }
  }, [spacingTemplates]);

  const handleApplySpacing = useCallback(
    async (row: SpacingBreakpoint, templateName: string) => {
      const applyKey = `${templateName}-${row.breakpoint}`;
      setApplyingSpacing(applyKey);

      try {
        const selection = await framer.getSelection();
        if (selection.length === 0) {
          framer.notify(
            "Select one or more containers before applying spacing.",
            {
              variant: "warning",
            }
          );
          return;
        }

        const attributes = getSpacingLayoutAttributes(row);
        let applied = 0;
        let failed = 0;

        // Sequential on purpose: applying attributes one node at a time via
        // the Framer plugin bridge doesn't tolerate a burst of concurrent
        // requests well.
        for (const node of selection) {
          try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            await node.setAttributes(
              attributes as unknown as Parameters<typeof node.setAttributes>[0]
            );
            applied += 1;
          } catch {
            failed += 1;
          }
        }

        if (applied === 0) {
          framer.notify("Could not apply spacing to the current selection.", {
            variant: "error",
          });
          return;
        }

        framer.notify(
          `Applied ${row.breakpoint} spacing to ${applied} selected item${applied === 1 ? "" : "s"}${
            failed > 0 ? `; ${failed} failed` : ""
          }.`,
          { variant: failed > 0 ? "warning" : "success" }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        framer.notify(`Could not apply spacing: ${message}`, {
          variant: "error",
        });
      } finally {
        setApplyingSpacing(null);
      }
    },
    []
  );

  const handleRunPreflight = useCallback(async () => {
    if (scanning) {
      return;
    }

    setScanning(true);
    setScanError(null);
    setViolationActions([]);

    try {
      const codeHealth = await scanCodeHealthSnapshot();
      const canvas = await scanCanvasInstancesSnapshot();
      const framerFiles = await framer.getCodeFiles();
      const remote = await scanRemoteImportsSnapshot(
        canvas.seedUrls,
        framerFiles.map((file) => file.name),
        canvas.instances
      );
      const codeFileIntegrity = await scanCodeFileIntegritySnapshot(
        remote.moduleScans,
        canvas.instances
      );
      const runtimeErrors = await collectInstanceRuntimeErrors(canvas.nodes);
      const brokenComponentIssues = findBrokenComponentIssues({
        instances: canvas.instances,
        moduleScans: remote.moduleScans,
        runtimeErrors,
      });
      const layoutDriftIssues = findLayoutDriftIssues(
        await collectLayoutDriftInput()
      );
      const teamInput = await collectTeamPreflightInput();
      const teamReport = await runTeamPreflight(teamInput, teamOptions, {
        checkExternalLinks,
        checkSpelling,
      });

      const framerFileIdByPath = new Map(
        framerFiles.map((f) => [f.path.toLowerCase(), f.id])
      );

      const rawActions = buildViolationActions(
        teamReport,
        codeFileIntegrity.issues,
        layoutDriftIssues,
        brokenComponentIssues,
        codeHealth.rawReport,
        remote.codeHits,
        framerFileIdByPath
      );
      const actions = await enrichViolationLocations(rawActions);
      setViolationActions(actions);
      framer.notify(
        actions.length > 0
          ? `Preflight found ${actions.length} actionable issue(s).`
          : "Preflight passed — no actionable issues found.",
        { variant: actions.length > 0 ? "warning" : "success" }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScanError(message);
      framer.notify(`Preflight failed: ${message}`, { variant: "error" });
    } finally {
      setScanned(true);
      setScanning(false);
    }
  }, [scanning, teamOptions]);

  const handleGoToViolation = useCallback(
    (action: ViolationAction) =>
      void goToViolation(action, setViolationActions),
    []
  );

  const handleFixViolation = useCallback(
    (action: ViolationAction) => void fixViolation(action, setViolationActions),
    []
  );

  const handleRecheckViolation = useCallback(
    (action: ViolationAction) =>
      void recheckViolation(action, setViolationActions),
    []
  );

  const handlePreviewOrganize = useCallback(async () => {
    if (organizeBusy) {
      return;
    }
    setOrganizeBusy("preview");
    setOrganizePlan(null);
    setOrganizeCanvasRows([]);
    setOrganizeStatus("Building organization plan…");

    try {
      // Category suggestions on top of the project's own components and
      // code files are a bonus, not a requirement — a failed fetch here
      // must not block organizing what the project already tells us.
      let manifest: Manifest = {
        categories: [],
        components: {},
        generatedAt: "",
        totalComponents: 0,
      };
      try {
        manifest = await fetchManifest(getDefaultManifestUrl());
      } catch {
        // No suggestions available; continue with project-only data.
      }

      const [codeFiles, canvasComponents, instances] = await Promise.all([
        framer.getCodeFiles(),
        framer.getNodesWithType("ComponentNode"),
        framer.getNodesWithType("ComponentInstanceNode"),
      ]);

      setOrganizeStatus(
        "Walking design pages for component masters and folders…"
      );
      const tree = await collectDesignComponentTree();
      organizeFolderIndexRef.current = {
        folderNodeIdByPath: tree.folderNodeIdByPath,
        rootIds: tree.rootIds,
      };

      // Merge masters from the node-tree walk with the type query — the walk
      // knows each component's real folder; the query catches masters that
      // live outside the scanned design pages.
      const componentById = new Map<
        string,
        {
          nodeId: string;
          name: string | null;
          componentName: string | null;
          folderPath?: string;
        }
      >();
      for (const node of canvasComponents) {
        componentById.set(node.id, {
          componentName: node.componentName,
          name: node.name,
          nodeId: node.id,
        });
      }
      for (const [id, master] of tree.masters) {
        const existing = componentById.get(id);
        componentById.set(id, {
          componentName:
            master.componentName ?? existing?.componentName ?? null,
          folderPath: master.folderPath,
          name: master.name ?? existing?.name ?? null,
          nodeId: id,
        });
      }

      const extraFolderNames = [
        ...new Set([
          ...tree.folderNodeIdByPath.keys(),
          ...[...instances, ...canvasComponents]
            .map((node) => folderFromComponentName(node.componentName))
            .filter(Boolean),
        ]),
      ];

      const plan = planComponentOrganization({
        canvasComponents: [...componentById.values()],
        codeFiles: codeFiles.map((file) => ({
          id: file.id,
          name: file.name,
          path: file.path,
        })),
        extraFolderNames,
        manifestComponents: Object.values(manifest.components),
      });

      setOrganizePlan(plan);
      setOrganizeCanvasRows(
        plan.canvasComponentSuggestions.map((suggestion) => ({
          baseName: suggestion.baseName,
          currentFolder: suggestion.currentFolder,
          // Components already foldered by hand stay put unless reassigned.
          folder:
            suggestion.currentFolder || (suggestion.suggestedFolder ?? ""),
          nodeId: suggestion.nodeId,
          reason: suggestion.reason,
        }))
      );
      const debugCodeFileLines = codeFiles
        .slice(0, 200)
        .map(
          (file) => `  • id=${file.id} name="${file.name}" path="${file.path}"`
        );

      const brokenImports = findBrokenCodeFileImports(codeFiles);
      const brokenImportLines = brokenImports.map(
        (broken) =>
          `  • ${broken.fromFile}\n      imports "${broken.specifier}" -> resolved "${broken.resolvedPath}" (not found)`
      );

      setOrganizeStatus(
        [
          formatOrganizePlan(plan),
          "",
          `Scanned ${tree.rootIds.length} page(s): found ${tree.masters.size} component(s) across ${tree.folderNodeIdByPath.size} folder(s).`,
          "",
          `Debug — code files with broken imports (${brokenImports.length}):`,
          ...brokenImportLines,
          "",
          `Debug — all code files (${codeFiles.length}):`,
          ...debugCodeFileLines,
          codeFiles.length > 200 ? `  … +${codeFiles.length - 200} more` : "",
        ].join("\n")
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOrganizeStatus(`Could not build organization plan: ${message}`);
      framer.notify(`Could not build organization plan: ${message}`, {
        variant: "error",
      });
    } finally {
      setOrganizeBusy(null);
    }
  }, [organizeBusy]);

  const handleApplyOrganize = useCallback(async () => {
    if (organizeBusy || !organizePlan) {
      return;
    }
    setOrganizeBusy("apply");

    try {
      const files = await framer.getCodeFiles();
      const filesById = new Map(files.map((file) => [file.id, file]));
      const { failures: repairFailures, repaired } = await repairCodeFileNames(
        filesById,
        organizePlan.codeFileNameRepairs
      );

      const changedRows = organizeCanvasRows.filter(
        (row) => row.folder.trim() !== row.currentFolder
      );
      const {
        failures: rowFailures,
        renameFallbacks,
        renamed,
      } = await applyCanvasFolderChanges(
        changedRows,
        organizeFolderIndexRef.current
      );
      const failures = [...repairFailures, ...rowFailures];

      setOrganizePlan(null);
      setOrganizeCanvasRows([]);
      setOrganizeStatus(
        [
          `Applied: restored ${repaired} corrupted file name(s), organized ${renamed} project component(s).`,
          ...(renameFallbacks.length > 0
            ? ["", `Notes (${renameFallbacks.length}):`, ...renameFallbacks]
            : []),
          ...(failures.length > 0
            ? ["", `Failed (${failures.length}):`, ...failures]
            : []),
          "",
          "Re-run the preview to verify, or run the cleanup scan to confirm nothing published broke.",
        ].join("\n")
      );
      framer.notify(
        failures.length > 0
          ? `Organized with ${failures.length} failure(s) — see the report.`
          : `Organized ${repaired + renamed} item(s).`,
        { variant: failures.length > 0 ? "warning" : "success" }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOrganizeStatus(`Could not apply organization plan: ${message}`);
      framer.notify(`Could not apply organization plan: ${message}`, {
        variant: "error",
      });
    } finally {
      setOrganizeBusy(null);
    }
  }, [organizeBusy, organizePlan, organizeCanvasRows]);

  const setOrganizeRowFolder = useCallback((nodeId: string, folder: string) => {
    setOrganizeCanvasRows((rows) =>
      rows.map((row) => (row.nodeId === nodeId ? { ...row, folder } : row))
    );
  }, []);

  const organizeChangeCount = useMemo(() => {
    const changedRows = organizeCanvasRows.filter(
      (row) => row.folder.trim() !== row.currentFolder
    ).length;
    return (organizePlan?.codeFileNameRepairs.length ?? 0) + changedRows;
  }, [organizePlan, organizeCanvasRows]);

  const toggleTeamOption = useCallback((key: OptionalCheckKey) => {
    setTeamOptions((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  const renderSection = () => {
    switch (section) {
      case "fonts": {
        return (
          <FontManagerPanel
            onOpenProjectCleanup={() => setSection("preflight")}
          />
        );
      }
      case "performance": {
        return (
          <PerformancePanel
            onOpenProjectCleanup={() => setSection("preflight")}
          />
        );
      }
      case "rename": {
        return <BatchRenamePanel />;
      }
      case "urlBuilder": {
        return <UrlBuilderPanel />;
      }
      case "organize": {
        return (
          <OrganizeSection
            onApply={() => void handleApplyOrganize()}
            onPreview={() => void handlePreviewOrganize()}
            onSetRowFolder={setOrganizeRowFolder}
            organizeBusy={organizeBusy}
            organizeCanvasRows={organizeCanvasRows}
            organizeChangeCount={organizeChangeCount}
            organizePlan={organizePlan}
            organizeStatus={organizeStatus}
          />
        );
      }
      case "preflight": {
        return (
          <PreflightSection
            onFixViolation={handleFixViolation}
            onGoToViolation={handleGoToViolation}
            onRecheckViolation={handleRecheckViolation}
            onRunPreflight={() => void handleRunPreflight()}
            onToggleTeamOption={toggleTeamOption}
            scanError={scanError}
            scanned={scanned}
            scanning={scanning}
            teamOptions={teamOptions}
            violationActions={violationActions}
          />
        );
      }
      default: {
        return (
          <SpacingSection
            applyingSpacing={applyingSpacing}
            onChangeTemplate={handleChangeSpacingTemplate}
            onCreateTemplate={handleCreateSpacingTemplate}
            onDeleteTemplate={handleDeleteSpacingTemplate}
            onDuplicateTemplate={handleDuplicateSpacingTemplate}
            onApplySpacing={(row, templateName) =>
              void handleApplySpacing(row, templateName)
            }
            onSaveTemplates={() => void handleSaveSpacingTemplates()}
            onSelectTemplate={setSelectedTemplateId}
            savingTemplates={savingTemplates}
            selectedTemplate={selectedTemplate}
            selectedTemplateId={selectedTemplateId}
            storageStatus={spacingStorageStatus}
            templates={spacingTemplates}
          />
        );
      }
    }
  };

  return (
    <div className="plugin-root">
      <header className="header">
        <div>
          <div className="header-kicker">RoleModel</div>
          <h1 className="header-title">Preflight</h1>
          <p className="header-copy">
            Scan the current project for code health, canvas module references,
            and the bundle imports that break published components.
          </p>
        </div>
        <div className="header-actions">
          {(
            [
              ["preflight", "Project cleanup"],
              ["spacing", "Spacing templates"],
              ["organize", "Organize"],
              ["rename", "Batch rename"],
              ["fonts", "Fonts"],
              ["performance", "Performance"],
              ["urlBuilder", "URL builder"],
            ] as const
          ).map(([key, label]) => (
            <button
              className={`btn${section === key ? " btn--active" : ""}`}
              key={key}
              onClick={() => setSection(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {renderSection()}
    </div>
  );
};
