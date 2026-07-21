/**
 * Compares repo-generated sync paths with Framer project code files and scans
 * for relative imports that resolve to missing RoleModel paths (common cause of
 * !missing/../codeFile/... runtime errors).
 */

export interface DirectSyncFileLike {
  syncPath: string;
  path: string;
  content: string;
}

export interface FramerCodeFileLike {
  path?: string;
  name: string;
  content: string;
}

export interface BrokenRelativeImport {
  /** Framer path or name */
  fromFile: string;
  specifier: string;
  /** Normalized RoleModel/... path we resolved to */
  resolvedPath: string;
}

export interface NestedLinkIssue {
  file: string;
  outerTag: string;
  innerTag: string;
  line: number;
  snippet: string;
}

export interface CodeHealthReport {
  /** syncPath entries (Category/File.tsx) not installed in Framer; informational */
  missingInFramer: string[];
  /** Relative imports in RoleModel code that point at non-existent files */
  brokenRelativeImports: BrokenRelativeImport[];
  /** Anchors or link-like buttons rendered inside another anchor */
  nestedLinks: NestedLinkIssue[];
  /** Count of RoleModel files scanned */
  scannedRoleModelFiles: number;
}

const normalizeSyncPath = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\/+/u, "");

const normalizeFramerPathSegment = (value: string): string =>
  value
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");

const toFramerSafePath = (path: string): string =>
  normalizeSyncPath(path)
    .split("/")
    .map((segment) => normalizeFramerPathSegment(segment))
    .join("/");

export const toFramerSyncFileName = (syncPath: string): string =>
  toFramerSafePath(`RoleModel/${syncPath}`);

export const toFramerPathKey = (path: string): string =>
  toFramerSafePath(path).toLowerCase();

const dirnameRoleModelPath = (filePath: string): string => {
  const normalized = normalizeSyncPath(filePath);
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }
  return normalized.slice(0, lastSlash);
};

const ensureTsxExtension = (path: string): string => {
  if (/\.[cm]?[jt]sx?$/iu.test(path)) {
    return path;
  }
  return `${path}.tsx`;
};

const resolvePathSegments = (baseDir: string, relative: string): string => {
  const baseParts = baseDir.split("/").filter(Boolean);
  const relParts = relative.split("/").filter(Boolean);
  const stack = [...baseParts];
  for (const part of relParts) {
    if (part === "..") {
      stack.pop();
    } else if (part !== ".") {
      stack.push(part);
    }
  }
  return stack.join("/");
};

/**
 * Resolve a relative or codeFile/ import to a RoleModel/... path.
 */
export const resolveSpecifierToRoleModelPath = (
  fromFilePath: string,
  specifier: string
): string | null => {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("codeFile/")) {
    const rest = normalizeSyncPath(trimmed.slice("codeFile/".length));
    return ensureTsxExtension(toFramerSafePath(`RoleModel/${rest}`));
  }

  if (!trimmed.startsWith(".")) {
    return null;
  }

  const fromDir = dirnameRoleModelPath(fromFilePath);
  if (!fromDir) {
    return null;
  }

  const joined = resolvePathSegments(fromDir, trimmed);
  const withExt = ensureTsxExtension(joined);
  return toFramerSafePath(withExt);
};

export const extractResolvableImportSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const fromRe = /\bfrom\s+["'](?<specifier>[^"']+)["']/gu;
  const dynImportRe = /\bimport\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu;
  let match: RegExpExecArray | null;

  while ((match = fromRe.exec(source)) !== null) {
    const { specifier } = match.groups ?? {};
    if (
      specifier &&
      (specifier.startsWith(".") || specifier.startsWith("codeFile/"))
    ) {
      out.push(specifier);
    }
  }
  while ((match = dynImportRe.exec(source)) !== null) {
    const { specifier } = match.groups ?? {};
    if (
      specifier &&
      (specifier.startsWith(".") || specifier.startsWith("codeFile/"))
    ) {
      out.push(specifier);
    }
  }
  return out;
};

const JSX_LINK_TOKEN_RE =
  /<\/?(?:a|motion\.a|Link)\b[^>]*>|<Button\b[^>]*\bhref\s*=[^>]*>/gu;

const lineForIndex = (source: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.codePointAt(i) === 10) {
      line += 1;
    }
  }
  return line;
};

const getTagName = (token: string): string => {
  const match = token.match(/^<\/?\s*(?<tag>[a-zA-Z.]+)/u);
  return match?.groups?.tag ?? "unknown";
};

const isClosingToken = (token: string): boolean => token.startsWith("</");

const isSelfClosingToken = (token: string): boolean => /\/\s*>$/u.test(token);

const isLinkLikeButton = (token: string): boolean => /^<Button\b/u.test(token);

const getLineSnippet = (source: string, index: number): string => {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = source.indexOf("\n", index);
  const end = lineEnd === -1 ? source.length : lineEnd;
  return source.slice(lineStart, end).trim();
};

export const findNestedLinkIssues = (
  source: string,
  file: string
): NestedLinkIssue[] => {
  const issues: NestedLinkIssue[] = [];
  const stack: { name: string; line: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = JSX_LINK_TOKEN_RE.exec(source)) !== null) {
    const [token] = match;
    const { index } = match;
    const name = getTagName(token);

    if (isClosingToken(token)) {
      const stackIndex = stack.findLastIndex((entry) => entry.name === name);
      if (stackIndex !== -1) {
        stack.splice(stackIndex);
      }
      continue;
    }

    const line = lineForIndex(source, index);
    if (stack.length > 0) {
      const outer = stack.at(-1);
      if (!outer) {
        continue;
      }
      issues.push({
        file,
        innerTag: name,
        line,
        outerTag: outer.name,
        snippet: getLineSnippet(source, index),
      });
    }

    if (!isSelfClosingToken(token) && !isLinkLikeButton(token)) {
      stack.push({ line, name });
    }
  }

  return issues;
};

export const analyzeCodeHealth = (input: {
  syncFiles: DirectSyncFileLike[];
  framerFiles: FramerCodeFileLike[];
}): CodeHealthReport => {
  const repoKeys = new Set(
    input.syncFiles.map((f) =>
      toFramerPathKey(toFramerSyncFileName(f.syncPath))
    )
  );

  const framerByKey = new Map<string, FramerCodeFileLike>();
  for (const f of input.framerFiles) {
    framerByKey.set(toFramerPathKey(f.path || f.name), f);
  }

  const missingInFramer: string[] = [];
  for (const f of input.syncFiles) {
    const key = toFramerPathKey(toFramerSyncFileName(f.syncPath));
    if (!framerByKey.has(key)) {
      missingInFramer.push(f.syncPath);
    }
  }

  const brokenRelativeImports: BrokenRelativeImport[] = [];
  const nestedLinks: NestedLinkIssue[] = [];
  let scannedRoleModelFiles = 0;

  for (const f of input.framerFiles) {
    const fp = f.path || f.name;
    const lower = normalizeSyncPath(fp).toLowerCase();
    if (!lower.startsWith("rolemodel/")) {
      continue;
    }
    scannedRoleModelFiles += 1;
    nestedLinks.push(...findNestedLinkIssues(f.content, fp));

    const specifiers = extractResolvableImportSpecifiers(f.content);
    for (const spec of specifiers) {
      const resolved = resolveSpecifierToRoleModelPath(fp, spec);
      if (!resolved) {
        continue;
      }
      const rKey = toFramerPathKey(resolved);
      if (framerByKey.has(rKey)) {
        continue;
      }
      // In repo manifest but not pushed yet — covered by missingInFramer, not a "wrong path"
      if (repoKeys.has(rKey)) {
        continue;
      }
      brokenRelativeImports.push({
        fromFile: fp,
        resolvedPath: resolved,
        specifier: spec,
      });
    }
  }

  return {
    brokenRelativeImports,
    missingInFramer: missingInFramer.toSorted((a, b) => a.localeCompare(b)),
    nestedLinks,
    scannedRoleModelFiles,
  };
};

/**
 * Human-readable summary for the plugin UI.
 */
export const formatCodeHealthReport = (report: CodeHealthReport): string => {
  const lines: string[] = [];

  if (report.missingInFramer.length > 0) {
    lines.push(
      `Library files not installed in this Framer project (${report.missingInFramer.length}) — informational only.`,
      "Do not run Sync Code Files (All) on a live project unless you intentionally want to install the full library.",
      "This is only a problem when an installed RoleModel file imports one of these missing files; that appears under Broken relative imports.",
      ""
    );
  } else {
    lines.push(
      "All library sync paths exist as Framer code files (by path key).",
      ""
    );
  }

  if (report.brokenRelativeImports.length > 0) {
    lines.push(
      `Broken relative imports (${report.brokenRelativeImports.length}) — target file not in project:`,
      ...report.brokenRelativeImports
        .slice(0, 30)
        .map(
          (row) =>
            `  • ${row.fromFile}\n      ${row.specifier} → ${row.resolvedPath}`
        ),
      report.brokenRelativeImports.length > 30
        ? `  … +${report.brokenRelativeImports.length - 30} more`
        : "",
      ""
    );
  } else if (report.scannedRoleModelFiles > 0) {
    lines.push(
      `No unresolved relative/codeFile imports in ${report.scannedRoleModelFiles} RoleModel file(s) (vs Framer + repo sync list).`,
      ""
    );
  }

  if (report.nestedLinks.length > 0) {
    lines.push(
      `Potential nested links (${report.nestedLinks.length}) — anchor/link rendered inside another anchor:`,
      ...report.nestedLinks
        .slice(0, 30)
        .map(
          (row) =>
            `  • ${row.file}:${row.line}\n      <${row.innerTag}> inside <${row.outerTag}> — ${row.snippet}`
        ),
      report.nestedLinks.length > 30
        ? `  … +${report.nestedLinks.length - 30} more`
        : "",
      ""
    );
  } else if (report.scannedRoleModelFiles > 0) {
    lines.push(
      "No obvious nested anchor/link patterns in scanned RoleModel files.",
      ""
    );
  }

  const hasLegacyHugeIconPath = report.brokenRelativeImports.some(
    (row) =>
      row.resolvedPath
        .toLowerCase()
        .includes("visuals_and_media/hugeiconfont") ||
      row.specifier.toLowerCase().includes("visuals_and_media/hugeiconfont")
  );
  if (hasLegacyHugeIconPath) {
    lines.push(
      'Hint: HugeIcon now lives at RoleModel/Utility/HugeIcon.tsx in this repo. Update relative imports or add a tiny re-export at the old path that does: export { default } from "../Utility/HugeIcon" (adjust relative depth as needed).',
      ""
    );
  }

  lines.push(
    "Note: Errors from published CDN packages (!missing/… or framerusercontent.com) or #framer/local/codeFile/… IDs are not fixed by syncing repo files — republish those packages or replace instances on the canvas.",
    ""
  );

  return lines.filter(Boolean).join("\n");
};
