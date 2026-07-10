/**
 * Scan fetched module JS for broken Framer bundle specifiers.
 * - `#framer/local/...` — project-local code file IDs
 * - `!missing/../codeFile/...` — build-time failed relative import (old paths e.g. Visuals_and_Media/HugeIcon)
 *
 * Framer's plugin API does not expose nested imports; fetching insertURL bodies is how we inspect them.
 */

export function findFramerLocalSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/#framer\/local\/[a-zA-Z0-9/._-]+/g)) {
    if (m[0]) {
      out.add(m[0]);
    }
  }
  return [...out].toSorted();
}

/**
 * Framer embeds `!missing/../codeFile/RoleModel/...` when a relative import could not be resolved
 * at publish time (moved folders, renamed files). These break at runtime until the package is republished
 * or instances use a fixed framer.com/m/… URL.
 */
export function findMissingBundledSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/!missing\/[^"']+/g)) {
    if (m[0]) {
      out.add(m[0]);
    }
  }
  return [...out].toSorted();
}

export function discoverNestedModuleUrls(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(
    /https:\/\/(?:framer\.com\/m\/[^"'`\s)]+|framerusercontent\.com\/[^"'`\s)]+)/g
  )) {
    if (m[0]) {
      out.add(m[0]);
    }
  }
  return [...out];
}

export interface FetchedModuleScan {
  url: string;
  roots: string[];
  ok: boolean;
  status?: number;
  locals: string[];
  missing: string[];
  error?: string;
}

export interface ModuleScanResult {
  scans: FetchedModuleScan[];
  truncated: boolean;
  maxTotalFetches: number;
  remainingQueue: number;
}

export interface CanvasInstanceForScan {
  id: string;
  insertURL: string | null;
  componentName?: string | null;
}

/**
 * BFS fetch from seed URLs (typically canvas insertURLs). Follows re-export chains
 * on framer.com/m/ → framerusercontent.com until no new URLs or limits hit.
 */
export async function scanModuleUrlsForFramerLocal(
  seedUrls: string[],
  options?: { maxTotalFetches?: number }
): Promise<ModuleScanResult> {
  const maxTotal = options?.maxTotalFetches ?? 600;
  const seen = new Set<string>();
  const queue: string[] = [];
  const rootsByUrl = new Map<string, Set<string>>();

  const addRoots = (url: string, roots: Iterable<string>) => {
    const set = rootsByUrl.get(url) ?? new Set<string>();
    for (const root of roots) {
      if (root) {
        set.add(root);
      }
    }
    rootsByUrl.set(url, set);
  };

  for (const u of seedUrls) {
    const t = String(u ?? "").trim();
    if (!t) {
      continue;
    }
    addRoots(t, [t]);
    if (!queue.includes(t)) {
      queue.push(t);
    }
  }

  const results: FetchedModuleScan[] = [];

  while (queue.length > 0 && results.length < maxTotal) {
    const url = queue.shift() as string;
    const roots = [...(rootsByUrl.get(url) ?? [])];
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);

    try {
      const res = await fetch(url, { method: "GET" });
      const text = await res.text();
      const locals = findFramerLocalSpecifiers(text);
      const missing = findMissingBundledSpecifiers(text);
      results.push({
        locals,
        missing,
        ok: res.ok,
        roots,
        status: res.status,
        url,
      });
      if (res.ok) {
        for (const next of discoverNestedModuleUrls(text)) {
          addRoots(next, roots);
          if (!seen.has(next) && !queue.includes(next)) {
            queue.push(next);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        error: message,
        locals: [],
        missing: [],
        ok: false,
        roots,
        url,
      });
    }
  }

  return {
    maxTotalFetches: maxTotal,
    remainingQueue: queue.length,
    scans: results,
    truncated: queue.length > 0 && results.length >= maxTotal,
  };
}

export interface CodeFileBundleHit {
  path: string;
  locals: string[];
  missing: string[];
}

export function scanCodeFileSourcesForFramerLocal(
  files: { path?: string; name: string; content: string }[]
): CodeFileBundleHit[] {
  const hits: CodeFileBundleHit[] = [];
  for (const f of files) {
    const locals = findFramerLocalSpecifiers(f.content);
    const missing = findMissingBundledSpecifiers(f.content);
    if (locals.length === 0 && missing.length === 0) {
      continue;
    }
    hits.push({
      locals,
      missing,
      path: f.path || f.name,
    });
  }
  return hits;
}

export function formatFramerLocalScanReport(input: {
  moduleScans: FetchedModuleScan[];
  codeHits: CodeFileBundleHit[];
  seedCount: number;
  truncated?: boolean;
  maxTotalFetches?: number;
  remainingQueue?: number;
  instances?: CanvasInstanceForScan[];
  projectNodeBaseUrl?: string;
}): string {
  const lines: string[] = [
    `Remote module import scan`,
    `Seeds: ${input.seedCount} distinct canvas insertURL(s). Fetched ${input.moduleScans.length} module file(s) (including re-export targets).`,
    "",
  ];

  if (input.truncated) {
    lines.push(
      `Scan hit fetch limit (${input.maxTotalFetches ?? input.moduleScans.length}) with ${input.remainingQueue ?? 0} URL(s) still queued; results may miss broken modules outside the scanned subset.`,
      ""
    );
  }

  const modWithMissing = input.moduleScans.filter((s) => s.missing.length > 0);
  const modWithLocals = input.moduleScans.filter((s) => s.locals.length > 0);
  const modWithErrors = input.moduleScans.filter((s) => !s.ok || s.error);

  const codeWithMissing = input.codeHits.filter((h) => h.missing.length > 0);
  const codeWithLocals = input.codeHits.filter((h) => h.locals.length > 0);

  const anyIssue =
    modWithMissing.length > 0 ||
    modWithLocals.length > 0 ||
    codeWithMissing.length > 0 ||
    codeWithLocals.length > 0;

  if (!anyIssue) {
    lines.push(
      "No #framer/local/… or !missing/… specifiers found in fetched module bodies or Code tab sources.",
      "",
      "If the canvas still errors, raise the fetch limit (more canvas instances than scan budget), or the bad import is only in a layout/published package not reached from these insertURLs."
    );
    return lines.join("\n");
  }

  const instancesByInsertUrl = new Map<string, CanvasInstanceForScan[]>();
  for (const instance of input.instances ?? []) {
    const url = String(instance.insertURL ?? "").trim();
    if (!url) {
      continue;
    }
    const list = instancesByInsertUrl.get(url) ?? [];
    list.push(instance);
    instancesByInsertUrl.set(url, list);
  }

  const projectNodeBaseUrl = String(input.projectNodeBaseUrl ?? "").trim();
  const toNodeUrl = (nodeId: string) =>
    projectNodeBaseUrl
      ? `${projectNodeBaseUrl}?node=${encodeURIComponent(nodeId)}`
      : "";
  const moduleNodeIdFromUrl = (url: string): string => {
    const match = String(url).match(/\/([A-Za-z0-9_]+)\.js(?:[?#].*)?$/);
    return match?.[1] ?? "";
  };

  const appendInstanceLinksForScan = (scan: FetchedModuleScan) => {
    const linkedInstances = new Map<string, CanvasInstanceForScan>();
    for (const root of scan.roots) {
      const matches = instancesByInsertUrl.get(root) ?? [];
      for (const instance of matches) {
        linkedInstances.set(instance.id, instance);
      }
    }
    if (linkedInstances.size === 0) {
      return;
    }

    lines.push(`    linked canvas instance(s): ${linkedInstances.size}`);
    for (const instance of linkedInstances.values()) {
      const name = instance.componentName ? ` (${instance.componentName})` : "";
      const nodeUrl = toNodeUrl(instance.id);
      if (nodeUrl) {
        lines.push(`    - ${instance.id}${name} -> ${nodeUrl}`);
      } else {
        lines.push(`    - ${instance.id}${name}`);
      }
    }
  };

  if (modWithMissing.length > 0) {
    lines.push(
      `!missing / unresolved codeFile imports (${modWithMissing.length} file(s)) — republish the component from a project with correct RoleModel paths, or replace the instance with a current framer.com/m/… package:`,
      ""
    );
    for (const s of modWithMissing) {
      lines.push(`— ${s.url}`);
      const moduleNodeId = moduleNodeIdFromUrl(s.url);
      const moduleNodeUrl = moduleNodeId ? toNodeUrl(moduleNodeId) : "";
      if (moduleNodeId && moduleNodeUrl) {
        lines.push(`    module node: ${moduleNodeId} -> ${moduleNodeUrl}`);
      } else if (moduleNodeId) {
        lines.push(`    module node: ${moduleNodeId}`);
      }
      if (!s.ok || s.error) {
        lines.push(`    fetch: ${s.error ?? `HTTP ${s.status ?? "?"}`}`);
      }
      for (const spec of s.missing) {
        lines.push(`    ${spec}`);
      }
      appendInstanceLinksForScan(s);
      lines.push("");
    }
  }

  if (modWithLocals.length > 0) {
    lines.push(`#framer/local (${modWithLocals.length} file(s)):`);
    for (const s of modWithLocals) {
      lines.push(`— ${s.url}`);
      const moduleNodeId = moduleNodeIdFromUrl(s.url);
      const moduleNodeUrl = moduleNodeId ? toNodeUrl(moduleNodeId) : "";
      if (moduleNodeId && moduleNodeUrl) {
        lines.push(`    module node: ${moduleNodeId} -> ${moduleNodeUrl}`);
      } else if (moduleNodeId) {
        lines.push(`    module node: ${moduleNodeId}`);
      }
      for (const loc of s.locals) {
        lines.push(`    ${loc}`);
      }
      appendInstanceLinksForScan(s);
      lines.push("");
    }
  }

  if (codeWithMissing.length > 0 || codeWithLocals.length > 0) {
    lines.push("Code tab sources:");
    for (const h of input.codeHits) {
      if (h.missing.length === 0 && h.locals.length === 0) {
        continue;
      }
      lines.push(`— ${h.path}`);
      for (const spec of h.missing) {
        lines.push(`    !missing: ${spec}`);
      }
      for (const loc of h.locals) {
        lines.push(`    ${loc}`);
      }
    }
    lines.push("");
  }

  if (
    modWithErrors.length > 0 &&
    modWithMissing.length === 0 &&
    modWithLocals.length === 0
  ) {
    lines.push("Fetch issues:", "");
    for (const s of modWithErrors.slice(0, 15)) {
      lines.push(`— ${s.url}: ${s.error ?? `HTTP ${s.status}`}`);
    }
    lines.push("");
  }

  lines.push(
    "Fixes: (1) Sync current generated RoleModel paths from this repo, then republish affected Framer packages. (2) Replace canvas instances that still point at legacy relative/codeFile imports with current published modules. (3) If scan hit the fetch limit, increase it and rescan."
  );

  return lines.join("\n").trimEnd();
}
