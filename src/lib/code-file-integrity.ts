import type {
  CanvasInstanceForScan,
  FetchedModuleScan,
} from "./scan-framer-local";

export interface CodeFileForIntegrity {
  id: string;
  name: string;
  path: string;
  content: string;
}

export interface CodeFilePathDriftIssue {
  id: string;
  name: string;
  path: string;
  content: string;
  expectedRootPath: string;
  reason: string;
  referencedBy: {
    url: string;
    instanceIds: string[];
  }[];
}

const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\/+/u, "");

const basename = (path: string): string =>
  normalizePath(path).split("/").at(-1) ?? path;

const stem = (path: string): string =>
  basename(path).replace(/\.[cm]?[jt]sx?$/iu, "");

const isNestedCodeFile = (file: CodeFileForIntegrity): boolean => {
  const normalized = normalizePath(file.path);
  return normalized.includes("/") && basename(normalized) === file.name;
};

const isPathSensitiveSource = (source: string): boolean =>
  source.includes("addPropertyControls") ||
  source.includes("@framerSupportedLayout") ||
  source.includes("@framer/plugin") ||
  /https:\/\/(?:cdn\.jsdelivr\.net|framerusercontent\.com|framer\.com\/m\/)/u.test(
    source
  );

export const findCodeFilePathDriftIssues = (input: {
  files: CodeFileForIntegrity[];
  moduleScans: FetchedModuleScan[];
  instances: CanvasInstanceForScan[];
}): CodeFilePathDriftIssue[] => {
  const rootPaths = new Set(
    input.files.map((file) => normalizePath(file.path))
  );
  const instancesByInsertUrl = new Map<string, CanvasInstanceForScan[]>();

  for (const instance of input.instances) {
    if (!instance.insertURL) {
      continue;
    }
    const list = instancesByInsertUrl.get(instance.insertURL) ?? [];
    list.push(instance);
    instancesByInsertUrl.set(instance.insertURL, list);
  }

  const issues: CodeFilePathDriftIssue[] = [];
  for (const file of input.files) {
    const expectedRootPath = file.name;
    if (
      !isNestedCodeFile(file) ||
      rootPaths.has(expectedRootPath) ||
      !isPathSensitiveSource(file.content)
    ) {
      continue;
    }

    const fileStem = stem(file.name).toLowerCase();
    const referencedBy = input.moduleScans
      .filter((scan) =>
        scan.codeFileReferences.some(
          (reference) => reference.toLowerCase() === fileStem
        )
      )
      .map((scan) => {
        const instanceIds = new Set<string>();
        for (const root of scan.roots) {
          for (const instance of instancesByInsertUrl.get(root) ?? []) {
            instanceIds.add(instance.id);
          }
        }
        return {
          instanceIds: [...instanceIds].toSorted(),
          url: scan.url,
        };
      });

    if (referencedBy.length === 0) {
      continue;
    }

    issues.push({
      content: file.content,
      expectedRootPath,
      id: file.id,
      name: file.name,
      path: file.path,
      reason:
        "External/generated module references this code file by basename, but the project code file lives in a folder. This can break branch-local component evaluation after moving code files.",
      referencedBy,
    });
  }

  return issues;
};

export const formatCodeFilePathDriftReport = (
  issues: CodeFilePathDriftIssue[]
): string => {
  const lines = ["Code file path integrity"];

  if (issues.length === 0) {
    lines.push("No path-sensitive code file drift found.");
    return lines.join("\n");
  }

  lines.push(
    `${issues.length} path-sensitive code file(s) appear moved relative to external module references:`,
    ""
  );

  for (const issue of issues.slice(0, 20)) {
    lines.push(
      `  • ${issue.path}`,
      `      expected root copy: ${issue.expectedRootPath}`,
      `      ${issue.reason}`
    );
    for (const reference of issue.referencedBy.slice(0, 4)) {
      const instances =
        reference.instanceIds.length > 0
          ? ` (${reference.instanceIds.length} linked instance(s): ${reference.instanceIds.join(", ")})`
          : "";
      lines.push(`      referenced by: ${reference.url}${instances}`);
    }
  }

  if (issues.length > 20) {
    lines.push(`  … +${issues.length - 20} more path drift issue(s)`);
  }

  return lines.join("\n");
};
