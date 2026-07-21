/**
 * Detects missing/broken components and ties each problem back to canvas nodes,
 * so the plugin can navigate straight to the affected instances.
 *
 * Signals combined here:
 * - `!missing/...` and `#framer/local/...` specifiers found in fetched module bodies
 *   (see scan-framer-local.ts) mapped back to instances via insertURL roots
 * - Suspicious insertURLs directly on canvas instances
 * - Per-instance runtime errors reported by Framer (when the API exposes them)
 */

import type {
  CanvasInstanceForScan,
  FetchedModuleScan,
} from "./scan-framer-local";

export interface InstanceRuntimeError {
  nodeId: string;
  componentName?: string | null;
  message: string;
}

export type BrokenComponentKind =
  | "missing-module-import"
  | "local-module-reference"
  | "suspicious-insert-url"
  | "module-fetch-failed"
  | "runtime-error";

export interface BrokenComponentIssue {
  id: string;
  kind: BrokenComponentKind;
  severity: "error" | "warning";
  /** Canvas node to navigate to. Absent when the broken module is not placed directly on the canvas. */
  nodeId?: string;
  componentName: string | null;
  insertURL: string | null;
  moduleUrl?: string;
  specifiers: string[];
  /** Code file paths the published module expects but could not resolve. */
  missingFilePaths: string[];
  detail: string;
}

/**
 * `!missing/../codeFile/RoleModel/Utility/Button.tsx` → `RoleModel/Utility/Button.tsx`
 */
export const parseMissingCodeFilePath = (specifier: string): string | null => {
  const match = specifier.match(/codeFile\/(?<path>.+?)(?:[?#].*)?$/u);
  const path = match?.groups?.path?.trim();
  return path ? path.replace(/^\/+/u, "") : null;
};

export const fileBasename = (path: string): string =>
  path.split("/").at(-1) ?? path;

const SUSPICIOUS_URL_MARKERS = [
  "!missing",
  "#framer/local",
  "/404-",
  "framercanvas.com",
];

export const isSuspiciousModuleUrl = (url: string): boolean => {
  const lower = url.toLowerCase();
  return SUSPICIOUS_URL_MARKERS.some((marker) => lower.includes(marker));
};

const instancesByInsertUrl = (
  instances: CanvasInstanceForScan[]
): Map<string, CanvasInstanceForScan[]> => {
  const map = new Map<string, CanvasInstanceForScan[]>();
  for (const instance of instances) {
    const url = String(instance.insertURL ?? "").trim();
    if (!url) {
      continue;
    }
    const list = map.get(url) ?? [];
    list.push(instance);
    map.set(url, list);
  }
  return map;
};

const linkedInstancesForScan = (
  scan: FetchedModuleScan,
  byInsertUrl: Map<string, CanvasInstanceForScan[]>
): CanvasInstanceForScan[] => {
  const linked = new Map<string, CanvasInstanceForScan>();
  for (const root of scan.roots) {
    for (const instance of byInsertUrl.get(root) ?? []) {
      linked.set(instance.id, instance);
    }
  }
  return [...linked.values()];
};

const collectRuntimeErrorIssues = (
  instances: CanvasInstanceForScan[],
  runtimeErrors: InstanceRuntimeError[]
): BrokenComponentIssue[] => {
  const issues: BrokenComponentIssue[] = [];
  for (const runtimeError of runtimeErrors) {
    const instance = instances.find((row) => row.id === runtimeError.nodeId);
    issues.push({
      componentName:
        runtimeError.componentName ?? instance?.componentName ?? null,
      detail: `Component fails at runtime: ${runtimeError.message}`,
      id: `broken-runtime-${runtimeError.nodeId}`,
      insertURL: instance?.insertURL ?? null,
      kind: "runtime-error",
      missingFilePaths: [],
      nodeId: runtimeError.nodeId,
      severity: "error",
      specifiers: [],
    });
  }
  return issues;
};

const collectSuspiciousUrlIssues = (
  instances: CanvasInstanceForScan[]
): BrokenComponentIssue[] => {
  const issues: BrokenComponentIssue[] = [];
  for (const instance of instances) {
    const url = String(instance.insertURL ?? "").trim();
    if (!url || !isSuspiciousModuleUrl(url)) {
      continue;
    }
    issues.push({
      componentName: instance.componentName ?? null,
      detail: `Instance points at a broken module URL: ${url}`,
      id: `broken-url-${instance.id}`,
      insertURL: url,
      kind: "suspicious-insert-url",
      missingFilePaths: [],
      nodeId: instance.id,
      severity: "error",
      specifiers: [],
    });
  }
  return issues;
};

const missingFilePathsForScan = (scan: FetchedModuleScan): string[] => [
  ...new Set(
    scan.missing
      .map((specifier) => parseMissingCodeFilePath(specifier))
      .filter((path): path is string => Boolean(path))
  ),
];

interface BrokenSpecifierGroup {
  kind: BrokenComponentKind;
  specifiers: string[];
  missingFilePaths: string[];
  describe: () => string;
}

const brokenSpecifierGroupsForScan = (
  scan: FetchedModuleScan,
  missingFilePaths: string[]
): BrokenSpecifierGroup[] => {
  const missingNames = missingFilePaths.map(fileBasename).join(", ");
  return [
    {
      describe: () =>
        missingFilePaths.length > 0
          ? `Imports ${missingNames}, but no code file exists at ${missingFilePaths.join(", ")}. Restore the file at that path, or republish the component from a project where it resolves.`
          : `Imports ${scan.missing.join(", ")} — the referenced code file could not be resolved when the package was published.`,
      kind: "missing-module-import",
      missingFilePaths,
      specifiers: scan.missing,
    },
    {
      describe: () =>
        "References project-local code that does not exist outside its source project. Republish the component from its source project.",
      kind: "local-module-reference",
      missingFilePaths: [],
      specifiers: scan.locals,
    },
  ];
};

const collectSpecifierGroupIssues = (
  scan: FetchedModuleScan,
  linked: CanvasInstanceForScan[],
  groups: BrokenSpecifierGroup[]
): BrokenComponentIssue[] => {
  const issues: BrokenComponentIssue[] = [];
  for (const group of groups) {
    if (group.specifiers.length === 0) {
      continue;
    }
    const detail = group.describe();

    if (linked.length === 0) {
      issues.push({
        componentName: null,
        detail: `${detail} No canvas instance links to this module directly — it is likely used by a layout template or reached through a nested import.`,
        id: `broken-${group.kind}-${scan.url}`,
        insertURL: null,
        kind: group.kind,
        missingFilePaths: group.missingFilePaths,
        moduleUrl: scan.url,
        severity: "error",
        specifiers: group.specifiers,
      });
      continue;
    }

    for (const instance of linked) {
      issues.push({
        componentName: instance.componentName ?? null,
        detail,
        id: `broken-${group.kind}-${scan.url}-${instance.id}`,
        insertURL: instance.insertURL ?? null,
        kind: group.kind,
        missingFilePaths: group.missingFilePaths,
        moduleUrl: scan.url,
        nodeId: instance.id,
        severity: "error",
        specifiers: group.specifiers,
      });
    }
  }
  return issues;
};

const collectFetchFailedIssues = (
  scan: FetchedModuleScan,
  byInsertUrl: Map<string, CanvasInstanceForScan[]>
): BrokenComponentIssue[] => {
  if (scan.ok && !scan.error) {
    return [];
  }
  const fetchDetail = scan.error ?? `HTTP ${scan.status ?? "?"}`;
  const issues: BrokenComponentIssue[] = [];
  for (const instance of linkedInstancesForScan(scan, byInsertUrl).filter(
    (row) => row.insertURL === scan.url
  )) {
    issues.push({
      componentName: instance.componentName ?? null,
      detail: `The component module could not be fetched (${fetchDetail}); the instance likely renders as missing.`,
      id: `broken-fetch-${scan.url}-${instance.id}`,
      insertURL: instance.insertURL ?? null,
      kind: "module-fetch-failed",
      missingFilePaths: [],
      moduleUrl: scan.url,
      nodeId: instance.id,
      severity: "warning",
      specifiers: [],
    });
  }
  return issues;
};

const collectModuleScanIssues = (
  scan: FetchedModuleScan,
  byInsertUrl: Map<string, CanvasInstanceForScan[]>
): BrokenComponentIssue[] => {
  const linked = linkedInstancesForScan(scan, byInsertUrl);
  const missingFilePaths = missingFilePathsForScan(scan);
  const groups = brokenSpecifierGroupsForScan(scan, missingFilePaths);
  return [
    ...collectSpecifierGroupIssues(scan, linked, groups),
    ...collectFetchFailedIssues(scan, byInsertUrl),
  ];
};

const dedupeIssuesById = (
  candidates: BrokenComponentIssue[]
): BrokenComponentIssue[] => {
  const seen = new Set<string>();
  const issues: BrokenComponentIssue[] = [];
  for (const issue of candidates) {
    if (seen.has(issue.id)) {
      continue;
    }
    seen.add(issue.id);
    issues.push(issue);
  }
  return issues;
};

export const findBrokenComponentIssues = (input: {
  instances: CanvasInstanceForScan[];
  moduleScans: FetchedModuleScan[];
  runtimeErrors?: InstanceRuntimeError[];
}): BrokenComponentIssue[] => {
  const byInsertUrl = instancesByInsertUrl(input.instances);

  const candidates = [
    ...collectRuntimeErrorIssues(input.instances, input.runtimeErrors ?? []),
    ...collectSuspiciousUrlIssues(input.instances),
    ...input.moduleScans.flatMap((scan) =>
      collectModuleScanIssues(scan, byInsertUrl)
    ),
  ];

  return dedupeIssuesById(candidates);
};

export const formatBrokenComponentReport = (
  issues: BrokenComponentIssue[],
  options?: { projectNodeBaseUrl?: string }
): string => {
  const lines = ["Broken components on canvas"];

  if (issues.length === 0) {
    lines.push(
      "No broken or missing components detected across canvas instances, runtime errors, and published module imports."
    );
    return lines.join("\n");
  }

  const projectNodeBaseUrl = String(options?.projectNodeBaseUrl ?? "").trim();
  const errorCount = issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  lines.push(
    `${issues.length} broken component finding(s) (${errorCount} error(s)). Use the actionable violations list to jump to each instance.`,
    ""
  );

  for (const issue of issues.slice(0, 30)) {
    const missingNames = issue.missingFilePaths.map(fileBasename).join(", ");
    const name =
      issue.componentName ??
      (missingNames ? `missing ${missingNames}` : "(unknown component)");
    lines.push(`  • [${issue.severity}] ${name} — ${issue.kind}`);
    if (issue.nodeId) {
      const nodeUrl = projectNodeBaseUrl
        ? ` -> ${projectNodeBaseUrl}?node=${encodeURIComponent(issue.nodeId)}`
        : "";
      lines.push(`      canvas node: ${issue.nodeId}${nodeUrl}`);
    }
    if (issue.moduleUrl) {
      lines.push(`      module: ${issue.moduleUrl}`);
    }
    lines.push(`      ${issue.detail}`);
  }

  if (issues.length > 30) {
    lines.push(`  … +${issues.length - 30} more broken component finding(s)`);
  }

  return lines.join("\n");
};
