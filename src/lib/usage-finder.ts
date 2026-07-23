/**
 * Finds every place a search term (a component name, published module base
 * name, or URL fragment) shows up across code file contents and canvas
 * instances, then turns those hits into a checklist that persists across
 * plugin sessions via framer.getPluginData/setPluginData.
 *
 * This exists because propagating a single component fix across a dozen
 * consumer files and every direct canvas placement is inherently manual —
 * Framer has no bulk-safe way to do it — and losing track of which of those
 * dozen were already handled is what turns a one-day fix into a recurring
 * mess. The scan finds the sites; the checklist remembers which ones are done.
 */

export interface UsageCodeFile {
  path: string;
  name: string;
  content: string;
}

export interface UsageCanvasInstance {
  id: string;
  insertURL: string | null;
  componentName?: string | null;
}

export interface UsageCodeFileMatch {
  id: string;
  kind: "code-file";
  path: string;
  name: string;
  matchCount: number;
  /**
   * The distinct identifiers/URLs actually matched (e.g. "Button_1" and
   * "Button-1-j33J92.js@J3U5oS6GYQyy5mEj3RgE" are different tokens even
   * though both contain "Button") — surfaced so two files that both loosely
   * match a query don't get mistaken for referencing the same component.
   */
  matchedTokens: string[];
}

export interface UsageCanvasMatch {
  id: string;
  kind: "canvas-instance";
  nodeId: string;
  componentName: string | null;
  insertURL: string | null;
}

export type UsageMatch = UsageCodeFileMatch | UsageCanvasMatch;

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let fromIndex = 0;
  for (;;) {
    const foundAt = haystack.indexOf(needle, fromIndex);
    if (foundAt === -1) {
      return count;
    }
    count += 1;
    fromIndex = foundAt + needle.length;
  }
};

const IDENTIFIER_TOKEN_CHAR = /[A-Za-z0-9_.@-]/u;

/**
 * For every occurrence of `query` in `content`, expands out to the full
 * contiguous identifier/URL it sits inside (e.g. a match on "Button" inside
 * `Button-0rIM19.js` expands to the whole module basename; a match inside
 * `Button_1` expands to that whole identifier) and returns the distinct set.
 * This is what lets two files that both loosely match a query show up as
 * referencing two visibly different components rather than "the same" one.
 */
export const extractMatchedTokens = (
  content: string,
  query: string
): string[] => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }
  const lowerContent = content.toLowerCase();
  const needle = trimmedQuery.toLowerCase();
  const tokens = new Set<string>();

  let fromIndex = 0;
  for (;;) {
    const foundAt = lowerContent.indexOf(needle, fromIndex);
    if (foundAt === -1) {
      break;
    }

    let start = foundAt;
    while (start > 0 && IDENTIFIER_TOKEN_CHAR.test(content[start - 1])) {
      start -= 1;
    }
    let end = foundAt + needle.length;
    while (end < content.length && IDENTIFIER_TOKEN_CHAR.test(content[end])) {
      end += 1;
    }

    const token = content.slice(start, end).replaceAll(/^\.+|\.+$/gu, "");
    if (token) {
      tokens.add(token);
    }
    fromIndex = foundAt + needle.length;
  }

  return [...tokens].toSorted((a, b) => a.localeCompare(b));
};

/**
 * Plain case-insensitive substring search — deliberately not a regex, since
 * the search terms this is built for (file basenames, published module URLs)
 * can contain regex-sensitive characters like `.` and users shouldn't have to
 * escape them.
 */
export const findComponentUsages = (input: {
  query: string;
  codeFiles: UsageCodeFile[];
  instances: UsageCanvasInstance[];
}): UsageMatch[] => {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  const needle = query.toLowerCase();

  const codeFileMatches: UsageCodeFileMatch[] = [];
  for (const file of input.codeFiles) {
    const matchCount = countOccurrences(file.content.toLowerCase(), needle);
    if (matchCount === 0) {
      continue;
    }
    codeFileMatches.push({
      id: `codefile:${file.path}`,
      kind: "code-file",
      matchCount,
      matchedTokens: extractMatchedTokens(file.content, query),
      name: file.name,
      path: file.path,
    });
  }

  const canvasMatches: UsageCanvasMatch[] = [];
  for (const instance of input.instances) {
    const haystack =
      `${instance.insertURL ?? ""} ${instance.componentName ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) {
      continue;
    }
    canvasMatches.push({
      componentName: instance.componentName ?? null,
      id: `instance:${instance.id}`,
      insertURL: instance.insertURL ?? null,
      kind: "canvas-instance",
      nodeId: instance.id,
    });
  }

  return [...codeFileMatches, ...canvasMatches];
};

/**
 * Literal, case-sensitive find/replace across a code file's raw content —
 * no regex, so URL fragments with `.`/`-`/`@` need no escaping. This is the
 * only side of "swap" that's actually real: canvas instances have no
 * writable componentIdentifier/insertURL anywhere in the plugin API (both
 * are `readonly`, and the one replace-style method Framer exposes only
 * targets an empty ComponentInstancePlaceholder, not a placed instance), so
 * repointing an existing canvas instance can't be automated by any plugin.
 */
export const replaceInCodeFileContent = (
  content: string,
  find: string,
  replaceWith: string
): { content: string; replacedCount: number } => {
  const trimmedFind = find.trim();
  if (!trimmedFind) {
    return { content, replacedCount: 0 };
  }
  const parts = content.split(trimmedFind);
  return {
    content: parts.join(replaceWith),
    replacedCount: parts.length - 1,
  };
};

export interface ReplacementPreviewSnippet {
  before: string;
  after: string;
}

export interface ReplacementPreview {
  replacedCount: number;
  snippets: ReplacementPreviewSnippet[];
  truncated: boolean;
}

const PREVIEW_CONTEXT_CHARS = 40;
const MAX_PREVIEW_SNIPPETS = 5;

/**
 * Computes what `replaceInCodeFileContent` would do, without writing
 * anything — a snippet of surrounding context per occurrence, so a swap can
 * be reviewed before it touches a real file. Caps at
 * `MAX_PREVIEW_SNIPPETS` occurrences; `truncated` says whether more exist.
 */
export const previewCodeFileReplacement = (
  content: string,
  find: string,
  replaceWith: string
): ReplacementPreview => {
  const trimmedFind = find.trim();
  if (!trimmedFind) {
    return { replacedCount: 0, snippets: [], truncated: false };
  }

  const snippets: ReplacementPreviewSnippet[] = [];
  let replacedCount = 0;
  let fromIndex = 0;
  for (;;) {
    const foundAt = content.indexOf(trimmedFind, fromIndex);
    if (foundAt === -1) {
      break;
    }
    replacedCount += 1;
    const matchEnd = foundAt + trimmedFind.length;

    if (snippets.length < MAX_PREVIEW_SNIPPETS) {
      const start = Math.max(0, foundAt - PREVIEW_CONTEXT_CHARS);
      const end = Math.min(content.length, matchEnd + PREVIEW_CONTEXT_CHARS);
      const leadingEllipsis = start > 0 ? "…" : "";
      const trailingEllipsis = end < content.length ? "…" : "";

      snippets.push({
        after:
          leadingEllipsis +
          content.slice(start, foundAt) +
          replaceWith +
          content.slice(matchEnd, end) +
          trailingEllipsis,
        before: leadingEllipsis + content.slice(start, end) + trailingEllipsis,
      });
    }

    fromIndex = matchEnd;
  }

  return {
    replacedCount,
    snippets,
    truncated: replacedCount > snippets.length,
  };
};

export type ChecklistItemKind = "code-file" | "canvas-instance" | "custom";

export interface ChecklistItem {
  id: string;
  kind: ChecklistItemKind;
  label: string;
  detail: string;
  done: boolean;
  createdAt: string;
  path?: string;
  nodeId?: string;
}

export const USAGE_FINDER_PLUGIN_DATA_KEY = "usage-finder-checklist-v1";

const isChecklistItem = (value: unknown): value is ChecklistItem => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "code-file" ||
      candidate.kind === "canvas-instance" ||
      candidate.kind === "custom") &&
    typeof candidate.label === "string" &&
    typeof candidate.detail === "string" &&
    typeof candidate.done === "boolean" &&
    typeof candidate.createdAt === "string"
  );
};

export const parseChecklistItems = (value: string | null): ChecklistItem[] => {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(isChecklistItem)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
};

const toChecklistItem = (
  match: UsageMatch,
  queryLabel: string
): ChecklistItem => {
  const createdAt = new Date().toISOString();
  if (match.kind === "code-file") {
    const tokenList =
      match.matchedTokens.length > 0
        ? ` Matched: ${match.matchedTokens.join(", ")}.`
        : "";
    return {
      createdAt,
      detail: `${match.matchCount} reference${match.matchCount === 1 ? "" : "s"} to "${queryLabel}" — update the import, then check off.${tokenList}`,
      done: false,
      id: match.id,
      kind: "code-file",
      label: match.name,
      path: match.path,
    };
  }
  return {
    createdAt,
    detail: `Canvas instance referencing "${queryLabel}" — repoint or replace, then check off.`,
    done: false,
    id: match.id,
    kind: "canvas-instance",
    label: match.componentName ?? "(unnamed instance)",
    nodeId: match.nodeId,
  };
};

/**
 * Adds newly found usages to an existing checklist without touching items
 * already there — re-running a scan must never reset progress on items the
 * user already checked off.
 */
export const mergeUsageMatchesIntoChecklist = (
  existing: ChecklistItem[],
  matches: UsageMatch[],
  queryLabel: string
): ChecklistItem[] => {
  const existingIds = new Set(existing.map((item) => item.id));
  const additions = matches
    .filter((match) => !existingIds.has(match.id))
    .map((match) => toChecklistItem(match, queryLabel));
  return [...existing, ...additions];
};

export const addCustomChecklistItem = (
  existing: ChecklistItem[],
  label: string
): ChecklistItem[] => {
  const trimmed = label.trim();
  if (!trimmed) {
    return existing;
  }
  const item: ChecklistItem = {
    createdAt: new Date().toISOString(),
    detail: "",
    done: false,
    id: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    kind: "custom",
    label: trimmed,
  };
  return [...existing, item];
};

export const toggleChecklistItem = (
  existing: ChecklistItem[],
  id: string
): ChecklistItem[] =>
  existing.map((item) =>
    item.id === id ? { ...item, done: !item.done } : item
  );

export const setChecklistItemDone = (
  existing: ChecklistItem[],
  id: string,
  done: boolean
): ChecklistItem[] =>
  existing.map((item) => (item.id === id ? { ...item, done } : item));

export const removeChecklistItem = (
  existing: ChecklistItem[],
  id: string
): ChecklistItem[] => existing.filter((item) => item.id !== id);
