import { framer, useIsAllowedTo } from "@framer/plugin";
import React, { useCallback, useEffect, useState } from "react";

import {
  addCustomChecklistItem,
  findComponentUsages,
  mergeUsageMatchesIntoChecklist,
  parseChecklistItems,
  previewCodeFileReplacement,
  removeChecklistItem,
  replaceInCodeFileContent,
  setChecklistItemDone,
  toggleChecklistItem,
  USAGE_FINDER_PLUGIN_DATA_KEY,
} from "./lib/usage-finder";
import type {
  ChecklistItem,
  ReplacementPreviewSnippet,
  UsageMatch,
} from "./lib/usage-finder";

interface PendingSwapFile {
  path: string;
  name: string;
  replacedCount: number;
  snippets: ReplacementPreviewSnippet[];
  truncated: boolean;
}

const resolveStableCanvasNodeId = async (
  nodeId: string
): Promise<string | null> => {
  let currentNode = await framer.getNode(nodeId);
  let depth = 0;

  // Each step depends on the previous node's parent, so this must stay
  // sequential — it's a single ancestor climb, not independent lookups.
  while (currentNode?.isReplica && depth < 12) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    currentNode = await currentNode.getParent();
    depth += 1;
  }

  return currentNode?.id ?? null;
};

export const UsageFinderPanel = () => {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<UsageMatch[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [customLabel, setCustomLabel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState(
    "Search for a component name, published module URL fragment, or file basename to find every place it's used."
  );
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [pendingSwap, setPendingSwap] = useState<PendingSwapFile[] | null>(
    null
  );
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canPersistChecklist = useIsAllowedTo("setPluginData");
  const canSwapFiles = useIsAllowedTo("CodeFile.setFileContent");

  useEffect(() => {
    const loadChecklist = async () => {
      try {
        const stored = await framer.getPluginData(USAGE_FINDER_PLUGIN_DATA_KEY);
        setChecklist(parseChecklistItems(stored));
      } catch {
        setChecklist([]);
      }
    };
    void loadChecklist();
  }, []);

  const persistChecklist = useCallback(async (next: ChecklistItem[]) => {
    setChecklist(next);
    if (!framer.isAllowedTo("setPluginData")) {
      setStatus(
        "Checklist updated for this session, but your permissions don't allow saving it — it won't be here next time you open the plugin."
      );
      return;
    }
    try {
      await framer.setPluginData(
        USAGE_FINDER_PLUGIN_DATA_KEY,
        JSON.stringify(next)
      );
    } catch (error) {
      setStatus(
        `Checklist changed but could not be saved: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, []);

  const handleScan = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setStatus("Enter a search term first.");
      return;
    }
    setScanning(true);
    try {
      const [codeFiles, instances] = await Promise.all([
        framer.getCodeFiles(),
        framer.getNodesWithType("ComponentInstanceNode"),
      ]);

      const found = findComponentUsages({
        codeFiles: codeFiles.map((file) => ({
          content: file.content,
          name: file.name,
          path: file.path,
        })),
        instances: instances.map((instance) => ({
          componentName:
            (instance as { componentName?: string | null }).componentName ??
            null,
          id: instance.id,
          insertURL:
            (instance as { insertURL?: string | null }).insertURL ?? null,
        })),
        query: trimmed,
      });

      setMatches(found);
      setStatus(
        found.length === 0
          ? `No matches for "${trimmed}" in ${codeFiles.length} code file(s) or ${instances.length} canvas instance(s).`
          : `Found ${found.length} usage(s) of "${trimmed}" across ${codeFiles.length} code file(s) and ${instances.length} canvas instance(s).`
      );
    } catch (error) {
      setStatus(
        `Scan failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setScanning(false);
    }
  }, [query]);

  const handleAddAllToChecklist = useCallback(() => {
    if (matches.length === 0) {
      return;
    }
    const next = mergeUsageMatchesIntoChecklist(
      checklist,
      matches,
      query.trim()
    );
    const added = next.length - checklist.length;
    void persistChecklist(next);
    setStatus(
      added === 0
        ? "Every match is already on the checklist."
        : `Added ${added} item(s) to the checklist.`
    );
  }, [checklist, matches, persistChecklist, query]);

  const handleAddCustom = useCallback(() => {
    if (!customLabel.trim()) {
      return;
    }
    void persistChecklist(addCustomChecklistItem(checklist, customLabel));
    setCustomLabel("");
  }, [checklist, customLabel, persistChecklist]);

  const handleToggle = useCallback(
    (id: string) => {
      void persistChecklist(toggleChecklistItem(checklist, id));
    },
    [checklist, persistChecklist]
  );

  const handleRemove = useCallback(
    (id: string) => {
      void persistChecklist(removeChecklistItem(checklist, id));
    },
    [checklist, persistChecklist]
  );

  const handleGoToNode = useCallback(async (nodeId: string, label: string) => {
    try {
      const stableNodeId = await resolveStableCanvasNodeId(nodeId);
      if (!stableNodeId) {
        throw new Error("Node not found");
      }
      await framer.navigateTo(stableNodeId, {
        select: true,
        zoomIntoView: { maxZoom: 1 },
      });
    } catch {
      framer.notify(
        `${label} is no longer available. Run the scan again to refresh its location.`,
        { variant: "error" }
      );
    }
  }, []);

  const handleOpenFile = useCallback(async (path: string) => {
    const codeFiles = await framer.getCodeFiles();
    const file = codeFiles.find((entry) => entry.path === path);
    if (!file) {
      await framer.notify(`Code file not found: ${path}`, {
        variant: "error",
      });
      return;
    }
    await file.navigateTo();
  }, []);

  /**
   * Rewrites one code file's content by literal find/replace and writes it
   * back via CodeFile.setFileContent — the only half of "swap" that's real.
   * Only called from handleConfirmSwap, never directly from a preview step,
   * so nothing gets written until the user has seen exactly what will
   * change. Returns the replaced-occurrence count, or null on failure
   * (already notified to the user).
   */
  // Not wrapped in useCallback: each composes several other memoized
  // callbacks plus direct state reads, and the project's two hooks lint
  // rules (react-hooks/exhaustive-deps vs. react-compiler) disagree about
  // what the dependency array should contain for that shape. Leaving these
  // as plain functions and letting the compiler handle memoization avoids
  // the conflict entirely.
  const swapOneFile = async (path: string): Promise<number | null> => {
    const codeFiles = await framer.getCodeFiles();
    const file = codeFiles.find((entry) => entry.path === path);
    if (!file) {
      framer.notify(`Code file not found: ${path}`, { variant: "error" });
      return null;
    }

    const { content, replacedCount } = replaceInCodeFileContent(
      file.content,
      findText,
      replaceText
    );
    if (replacedCount === 0) {
      framer.notify(`No exact match for "${findText}" in ${file.name}.`, {
        variant: "warning",
      });
      return null;
    }

    if (!framer.isAllowedTo("CodeFile.setFileContent")) {
      framer.notify(`Your permissions don't allow editing ${file.name}.`, {
        variant: "error",
      });
      return null;
    }

    try {
      await file.setFileContent(content);
      return replacedCount;
    } catch (error) {
      framer.notify(
        `Could not save ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        { variant: "error" }
      );
      return null;
    }
  };

  const handlePreviewFile = async (path: string) => {
    const find = findText.trim();
    if (!find || !replaceText.trim()) {
      setStatus("Fill in both Find and Replace with before previewing.");
      return;
    }
    setPreviewing(true);
    try {
      const codeFiles = await framer.getCodeFiles();
      const file = codeFiles.find((entry) => entry.path === path);
      if (!file) {
        framer.notify(`Code file not found: ${path}`, { variant: "error" });
        return;
      }
      const preview = previewCodeFileReplacement(
        file.content,
        find,
        replaceText
      );
      if (preview.replacedCount === 0) {
        framer.notify(`No exact match for "${find}" in ${file.name}.`, {
          variant: "warning",
        });
        setPendingSwap(null);
        return;
      }
      setPendingSwap([
        {
          name: file.name,
          path: file.path,
          replacedCount: preview.replacedCount,
          snippets: preview.snippets,
          truncated: preview.truncated,
        },
      ]);
      setStatus(
        `Preview ready for ${file.name} — review below, then confirm to save.`
      );
    } finally {
      setPreviewing(false);
    }
  };

  /**
   * Finds every code file containing an exact, literal match for `findText`
   * directly — independent of whatever's in the Matches list above. Swap
   * used to reuse `matches` (built from the separate Search box's `query`),
   * which meant it silently did nothing whenever `findText` didn't happen to
   * equal the last search term, or no scan had been run yet at all.
   */
  const handlePreviewAll = async () => {
    const find = findText.trim();
    if (!find || !replaceText.trim()) {
      setStatus("Fill in both Find and Replace with before previewing.");
      return;
    }
    setPreviewing(true);
    try {
      const codeFiles = await framer.getCodeFiles();
      const pending: PendingSwapFile[] = [];
      for (const file of codeFiles) {
        const preview = previewCodeFileReplacement(
          file.content,
          find,
          replaceText
        );
        if (preview.replacedCount > 0) {
          pending.push({
            name: file.name,
            path: file.path,
            replacedCount: preview.replacedCount,
            snippets: preview.snippets,
            truncated: preview.truncated,
          });
        }
      }

      if (pending.length === 0) {
        setStatus(`No code file contains the exact text "${find}".`);
        setPendingSwap(null);
        return;
      }
      setPendingSwap(pending);
      setStatus(
        `Preview ready for ${pending.length} file(s) — review below, then confirm to save.`
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirmSwap = async () => {
    if (!pendingSwap) {
      return;
    }
    setConfirming(true);
    try {
      let succeeded = 0;
      let checklistNext = checklist;
      for (const item of pendingSwap) {
        // Sequential on purpose: each write depends on reading the file's
        // current content first, so parallel writes could race and clobber
        // each other's changes.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const replacedCount = await swapOneFile(item.path);
        if (replacedCount !== null) {
          succeeded += 1;
          checklistNext = setChecklistItemDone(
            checklistNext,
            `codefile:${item.path}`,
            true
          );
        }
      }
      void persistChecklist(checklistNext);
      setStatus(`Swapped in ${succeeded} of ${pendingSwap.length} file(s).`);
      setPendingSwap(null);
      // Only refresh the Matches list if it's actually driven by a query —
      // otherwise this would overwrite the status above with "Enter a
      // search term first," making a real success look broken.
      if (query.trim()) {
        await handleScan();
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleCancelSwap = () => {
    setPendingSwap(null);
    setStatus("Swap cancelled — nothing was changed.");
  };

  const remaining = checklist.filter((item) => !item.done).length;

  return (
    <div className="performance-dashboard">
      <section className="panel">
        <div className="panel-topline">
          <span className="panel-label">Usage finder</span>
        </div>
        <p className="panel-muted">
          Find every code file and canvas instance referencing a component — by
          name, file basename, or published module URL fragment (e.g.{" "}
          <code>Button-0rIM19</code>) — before you touch anything. This does not
          change any file or instance; repointing still has to happen by hand,
          one site at a time.
        </p>

        <div className="performance-form">
          <label htmlFor="usage-finder-query">
            Search term
            <input
              id="usage-finder-query"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleScan();
                }
              }}
              placeholder="Button, Button-0rIM19, ColumnCard.tsx…"
              type="text"
              value={query}
            />
          </label>
        </div>

        <div className="performance-actions">
          <button
            className="btn btn--primary btn--medium"
            disabled={scanning}
            onClick={() => void handleScan()}
            type="button"
          >
            {scanning ? "Scanning…" : "Scan for usages"}
          </button>
          <button
            className="btn btn--medium"
            disabled={matches.length === 0}
            onClick={handleAddAllToChecklist}
            type="button"
          >
            Add all to checklist
          </button>
        </div>

        <p className="panel-muted">{status}</p>
      </section>

      <section className="panel">
        <div className="panel-topline">
          <span className="panel-label">Swap</span>
        </div>
        <p className="panel-muted">
          Rewrites an exact string in a code file&apos;s source and saves it —
          this is real, not a preview. It only works on code files: canvas
          instances have no writable componentIdentifier or insertURL anywhere
          in the plugin API, so an existing placed instance can&apos;t be
          repointed by any plugin, including this one. Use Framer&apos;s own
          canvas tools for that.
        </p>
        <p className="panel-muted">
          Find is exact and case-sensitive, unlike the search above —
          that&apos;s deliberate, so a swap can&apos;t quietly mangle the casing
          of some other identifier. This works on its own; it doesn&apos;t need
          a scan first. If you have run a scan, don&apos;t retype the text from
          memory — click one of the &quot;Matched&quot; buttons on a result
          below to fill Find with the precise text found in that file.
        </p>
        {canSwapFiles ? null : (
          <p className="panel-muted">
            Your permissions on this project don&apos;t allow editing code
            files, so swapping is disabled here.
          </p>
        )}

        <div className="performance-form">
          <label htmlFor="usage-finder-find">
            Find (exact text)
            <input
              id="usage-finder-find"
              onChange={(event) => setFindText(event.target.value)}
              placeholder="https://framer.com/m/Button-1-j33J92.js@..."
              type="text"
              value={findText}
            />
          </label>
          <label htmlFor="usage-finder-replace">
            Replace with
            <input
              id="usage-finder-replace"
              onChange={(event) => setReplaceText(event.target.value)}
              placeholder="https://framer.com/m/Button-0rIM19.js"
              type="text"
              value={replaceText}
            />
          </label>
        </div>

        <div className="performance-actions">
          <button
            className="btn btn--primary btn--medium"
            disabled={
              !canSwapFiles ||
              previewing ||
              confirming ||
              !findText.trim() ||
              !replaceText.trim()
            }
            onClick={() => void handlePreviewAll()}
            type="button"
          >
            {previewing
              ? "Previewing…"
              : "Preview swap across every matching code file"}
          </button>
        </div>
      </section>

      {pendingSwap ? (
        <section className="panel">
          <div className="panel-topline">
            <span className="panel-label">
              Pending swap — nothing saved yet
            </span>
            <span className="panel-muted">{pendingSwap.length} file(s)</span>
          </div>
          <div className="performance-findings">
            {pendingSwap.map((item) => (
              <article className="performance-finding" key={item.path}>
                <div className="performance-finding__header">
                  <strong>{item.name}</strong>
                  <span className="panel-muted">
                    {item.replacedCount} occurrence
                    {item.replacedCount === 1 ? "" : "s"}
                    {item.truncated ? " (showing first 5)" : ""}
                  </span>
                </div>
                {item.snippets.map((snippet, index) => (
                  <div
                    className="usage-finder-diff"
                    key={`${item.path}-${index}`}
                  >
                    <p className="usage-finder-diff__before">
                      − {snippet.before}
                    </p>
                    <p className="usage-finder-diff__after">
                      + {snippet.after}
                    </p>
                  </div>
                ))}
              </article>
            ))}
          </div>
          <div className="performance-actions">
            <button
              className="btn btn--primary btn--medium"
              disabled={confirming}
              onClick={() => void handleConfirmSwap()}
              type="button"
            >
              {confirming
                ? "Saving…"
                : `Confirm and save ${pendingSwap.length} file(s)`}
            </button>
            <button
              className="btn btn--medium"
              disabled={confirming}
              onClick={handleCancelSwap}
              type="button"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {matches.length > 0 ? (
        <div className="performance-findings">
          <div className="panel-topline">
            <span className="panel-label">Matches</span>
            <span className="panel-muted">{matches.length} found</span>
          </div>
          {matches.map((match) => (
            <article className="performance-finding" key={match.id}>
              <div className="performance-finding__header">
                <span className="performance-severity performance-severity--info">
                  {match.kind === "code-file" ? "code file" : "canvas"}
                </span>
                <strong>
                  {match.kind === "code-file"
                    ? match.name
                    : (match.componentName ?? "(unnamed instance)")}
                </strong>
              </div>
              {match.kind === "code-file" ? (
                <>
                  <p>
                    {match.matchCount} reference
                    {match.matchCount === 1 ? "" : "s"} in {match.path}
                  </p>
                  {match.matchedTokens.length > 0 ? (
                    <div className="performance-finding__actions">
                      <strong>Matched:</strong>
                      {match.matchedTokens.map((token) => (
                        <button
                          className="btn btn--small"
                          key={token}
                          onClick={() => setFindText(token)}
                          title="Use this exact text as Find, below — typing it from memory risks a case or character mismatch that silently matches nothing."
                          type="button"
                        >
                          {token}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <p>{match.insertURL ?? "(no insert URL)"}</p>
              )}
              <div className="performance-finding__actions">
                {match.kind === "code-file" ? (
                  <>
                    <button
                      className="btn btn--primary"
                      onClick={() => void handleOpenFile(match.path)}
                      type="button"
                    >
                      Open {match.name}
                    </button>
                    <button
                      className="btn"
                      disabled={
                        !canSwapFiles ||
                        previewing ||
                        confirming ||
                        !findText.trim() ||
                        !replaceText.trim()
                      }
                      onClick={() => void handlePreviewFile(match.path)}
                      type="button"
                    >
                      {previewing ? "Previewing…" : "Preview swap"}
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn--primary"
                    onClick={() =>
                      void handleGoToNode(
                        match.nodeId,
                        match.componentName ?? "Instance"
                      )
                    }
                    type="button"
                  >
                    Go to instance
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-topline">
          <span className="panel-label">Checklist</span>
          <span className="panel-muted">
            {checklist.length === 0
              ? "Nothing tracked yet"
              : `${remaining} of ${checklist.length} remaining`}
          </span>
        </div>
        <p className="panel-muted">
          {canPersistChecklist
            ? "Saved to this project — it stays here across sessions, browser reloads, and days, so a multi-site cleanup doesn't lose its place."
            : "Your permissions on this project don't allow saving plugin data, so this checklist only lasts for the current session."}
        </p>

        <div className="performance-form">
          <label htmlFor="usage-finder-custom">
            Add a custom item
            <input
              id="usage-finder-custom"
              onChange={(event) => setCustomLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleAddCustom();
                }
              }}
              placeholder="e.g. Delete OldButton.tsx once nothing references it"
              type="text"
              value={customLabel}
            />
          </label>
        </div>
        <div className="performance-actions">
          <button
            className="btn btn--medium"
            disabled={!customLabel.trim()}
            onClick={handleAddCustom}
            type="button"
          >
            Add to checklist
          </button>
        </div>

        {checklist.length > 0 ? (
          <div className="performance-findings">
            {checklist.map((item) => (
              <article className="performance-finding" key={item.id}>
                <div className="performance-finding__header">
                  <label className="optimizer-checkbox">
                    <input
                      checked={item.done}
                      onChange={() => handleToggle(item.id)}
                      type="checkbox"
                    />
                    <strong
                      className={
                        item.done ? "usage-finder-item__label--done" : undefined
                      }
                    >
                      {item.label}
                    </strong>
                  </label>
                </div>
                {item.detail ? <p>{item.detail}</p> : null}
                <div className="performance-finding__actions">
                  {item.kind === "code-file" && item.path ? (
                    <button
                      className="btn btn--primary"
                      onClick={() => void handleOpenFile(item.path as string)}
                      type="button"
                    >
                      Open file
                    </button>
                  ) : null}
                  {item.kind === "canvas-instance" && item.nodeId ? (
                    <button
                      className="btn btn--primary"
                      onClick={() =>
                        void handleGoToNode(item.nodeId as string, item.label)
                      }
                      type="button"
                    >
                      Go to instance
                    </button>
                  ) : null}
                  <button
                    className="btn btn--ghost"
                    onClick={() => handleRemove(item.id)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
};
