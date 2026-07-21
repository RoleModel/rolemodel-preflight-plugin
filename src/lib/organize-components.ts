/**
 * Plans folder organization for canvas components, and detects code files
 * with corrupted names left behind by an earlier version of this feature.
 *
 * - Canvas components (assets panel) are grouped with `Category/Name` names,
 *   applied via node.setAttributes({ name }).
 * - Code files cannot be moved into folders by a plugin: `CodeFile.rename()`
 *   only sets the flat file name, and `CodeFile.path` has no setter anywhere
 *   in the Plugin API. An earlier version of this feature called
 *   `rename("Folder/File.tsx")` assuming Framer would treat the slash as a
 *   move — instead it just stores that whole string as the file's literal
 *   name, which Framer's own Code panel then can't resolve back into a real
 *   folder, and which breaks saves from any editor session still holding the
 *   old name. `findCodeFileNameRepairs` detects files already broken this
 *   way so they can be renamed back to a plain file name.
 *
 * Files whose basenames are referenced by published module bundles are left
 * in place: moving them breaks branch-local evaluation of those packages
 * (the same failure mode code-file-integrity.ts detects).
 */

export interface OrganizableCodeFile {
  id: string;
  name: string;
  path: string;
}

export interface OrganizableCanvasComponent {
  nodeId: string;
  name: string | null;
  componentName?: string | null;
  /**
   * Folder path resolved from the node tree (assets-panel folders are real
   * parent nodes, not name prefixes). Overrides slash-prefix parsing.
   */
  folderPath?: string | null;
}

export interface ManifestComponentForOrganize {
  key: string;
  displayName: string;
  category: string;
  syncPath?: string;
}

export interface CodeFileNameRepair {
  fileId: string;
  currentName: string;
  restoredName: string;
}

export interface CanvasComponentSuggestion {
  nodeId: string;
  /** Component name without any folder prefix. */
  baseName: string;
  /** Current folder derived from the slash-prefixed name; "" when at root. */
  currentFolder: string;
  /** Manifest category when the component matches; null when unmatched. */
  suggestedFolder: string | null;
  reason: string;
}

export interface SkippedOrganizeItem {
  name: string;
  reason: string;
}

export interface OrganizePlan {
  codeFileNameRepairs: CodeFileNameRepair[];
  canvasComponentSuggestions: CanvasComponentSuggestion[];
  /** Folder names offered in the picker: manifest categories + folders already in use. */
  folderOptions: string[];
  skipped: SkippedOrganizeItem[];
}

export const componentNameForFolder = (
  baseName: string,
  folder: string
): string => {
  const cleanFolder = folder
    .trim()
    .replaceAll("\\", "/")
    .replaceAll(/^\/+|\/+$/gu, "");
  return cleanFolder ? `${cleanFolder}/${baseName}` : baseName;
};

const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\/+/u, "");

const basename = (path: string): string =>
  normalizePath(path).split("/").at(-1) ?? path;

const stem = (path: string): string =>
  basename(path).replace(/\.[cm]?[jt]sx?$/iu, "");

const normalizeIdentifier = (value: string): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");

const sanitizeFolderName = (value: string): string =>
  value
    .trim()
    .replaceAll(/[/\\]+/gu, " ")
    .replaceAll(/\s+/gu, " ");

const UNCATEGORIZED_RE = /^uncategorized$/iu;

const buildManifestIndex = (
  components: ManifestComponentForOrganize[]
): Map<string, ManifestComponentForOrganize> => {
  const index = new Map<string, ManifestComponentForOrganize>();
  for (const component of components) {
    for (const token of [
      normalizeIdentifier(component.key),
      normalizeIdentifier(component.displayName),
      component.syncPath ? normalizeIdentifier(stem(component.syncPath)) : "",
    ]) {
      if (token && !index.has(token)) {
        index.set(token, component);
      }
    }
  }
  return index;
};

export const folderFromComponentName = (value: string | null): string => {
  const parts = String(value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, -1).join("/");
};

const collectFolderOptions = (
  manifestComponents: ManifestComponentForOrganize[],
  extraFolderNames: string[]
): Set<string> => {
  const folderOptions = new Set<string>();
  for (const component of manifestComponents) {
    const category = sanitizeFolderName(component.category ?? "");
    if (category && !UNCATEGORIZED_RE.test(category)) {
      folderOptions.add(category);
    }
  }
  for (const folder of extraFolderNames) {
    const trimmed = folder.trim().replaceAll(/^\/+|\/+$/gu, "");
    if (trimmed) {
      folderOptions.add(trimmed);
    }
  }
  return folderOptions;
};

/**
 * Detects code files with a "/" in their `name` — the signature left behind
 * by the old (broken) code-file-move feature, which passed a folder-prefixed
 * string to `CodeFile.rename()` believing it would relocate the file. It
 * doesn't: Framer just stores the whole string as the literal file name.
 * The fix is renaming back to the plain basename.
 */
const findCodeFileNameRepairs = (
  codeFiles: OrganizableCodeFile[]
): CodeFileNameRepair[] => {
  const repairs: CodeFileNameRepair[] = [];
  for (const file of codeFiles) {
    if (!file.name.includes("/")) {
      continue;
    }
    const restoredName = basename(file.name);
    if (restoredName && restoredName !== file.name) {
      repairs.push({
        currentName: file.name,
        fileId: file.id,
        restoredName,
      });
    }
  }
  return repairs;
};

/**
 * The folder path may live in either field: `name` is the layer name,
 * `componentName` the component's own name. Prefer whichever carries a
 * slash-folder prefix.
 */
const resolveCurrentName = (component: OrganizableCanvasComponent): string => {
  const nameCandidates = [component.name, component.componentName]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  return (
    nameCandidates.find((value) => value.includes("/")) ??
    nameCandidates[0] ??
    ""
  );
};

const describeCanvasSuggestionReason = (
  suggestedFolder: string | null,
  currentFolder: string
): string => {
  if (suggestedFolder) {
    return currentFolder && currentFolder !== suggestedFolder
      ? `Currently in ${currentFolder}/; suggested category: ${suggestedFolder}.`
      : `Suggested category: ${suggestedFolder}.`;
  }
  return currentFolder
    ? `Currently in ${currentFolder}/.`
    : "No suggestion available — choose a folder.";
};

const planCanvasComponentSuggestions = (
  canvasComponents: OrganizableCanvasComponent[],
  index: Map<string, ManifestComponentForOrganize>,
  folderOptions: Set<string>
): {
  canvasComponentSuggestions: CanvasComponentSuggestion[];
  skipped: SkippedOrganizeItem[];
} => {
  const canvasComponentSuggestions: CanvasComponentSuggestion[] = [];
  const skipped: SkippedOrganizeItem[] = [];

  for (const component of canvasComponents) {
    const currentName = resolveCurrentName(component);
    if (!currentName) {
      skipped.push({
        name: component.nodeId,
        reason: "Canvas component has no name to organize by.",
      });
      continue;
    }

    const parts = currentName
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const baseName = parts.at(-1) ?? currentName;
    const nodeTreeFolder = (component.folderPath ?? "").trim();
    const currentFolder = nodeTreeFolder || parts.slice(0, -1).join("/");
    if (currentFolder) {
      folderOptions.add(currentFolder);
    }

    const match = index.get(normalizeIdentifier(baseName));
    const category = match ? sanitizeFolderName(match.category ?? "") : "";
    const suggestedFolder =
      category && !UNCATEGORIZED_RE.test(category) ? category : null;

    canvasComponentSuggestions.push({
      baseName,
      currentFolder,
      nodeId: component.nodeId,
      reason: describeCanvasSuggestionReason(suggestedFolder, currentFolder),
      suggestedFolder,
    });
  }

  return { canvasComponentSuggestions, skipped };
};

export const planComponentOrganization = (input: {
  codeFiles: OrganizableCodeFile[];
  canvasComponents: OrganizableCanvasComponent[];
  manifestComponents: ManifestComponentForOrganize[];
  /** Extra folder names discovered elsewhere (e.g. instance componentName prefixes). */
  extraFolderNames?: string[];
}): OrganizePlan => {
  const index = buildManifestIndex(input.manifestComponents);

  const folderOptions = collectFolderOptions(
    input.manifestComponents,
    input.extraFolderNames ?? []
  );

  const codeFileNameRepairs = findCodeFileNameRepairs(input.codeFiles);

  const { canvasComponentSuggestions, skipped: canvasSkipped } =
    planCanvasComponentSuggestions(
      input.canvasComponents,
      index,
      folderOptions
    );

  return {
    canvasComponentSuggestions,
    codeFileNameRepairs,
    folderOptions: [...folderOptions].toSorted((a, b) => a.localeCompare(b)),
    skipped: canvasSkipped,
  };
};

export const formatOrganizePlan = (plan: OrganizePlan): string => {
  const lines = [
    "Component organization plan",
    `${plan.canvasComponentSuggestions.length} project component(s) listed for folder assignment.`,
    plan.folderOptions.length > 0
      ? `Folder options detected: ${plan.folderOptions.join(", ")}`
      : "No existing folders detected — folder names are still free to type.",
  ];

  if (plan.codeFileNameRepairs.length > 0) {
    lines.push(
      "",
      `Corrupted file names found (${plan.codeFileNameRepairs.length}) — an earlier version of this plugin tried to move these into folders by renaming them, which Framer doesn't support. They'll be restored to a plain file name:`
    );
    for (const repair of plan.codeFileNameRepairs) {
      lines.push(`  • "${repair.currentName}" -> "${repair.restoredName}"`);
    }
  }

  if (plan.skipped.length > 0) {
    lines.push("", `Skipped (${plan.skipped.length}):`);
    for (const item of plan.skipped.slice(0, 25)) {
      lines.push(`  • ${item.name} — ${item.reason}`);
    }
    if (plan.skipped.length > 25) {
      lines.push(`  … +${plan.skipped.length - 25} more skipped item(s)`);
    }
  }

  return lines.join("\n");
};
