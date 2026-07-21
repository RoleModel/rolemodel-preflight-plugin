import type { CanvasNode } from "@framer/plugin";
import {
  ComponentInstanceNode,
  FrameNode,
  framer,
  SVGNode,
  TextNode,
} from "@framer/plugin";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  computeBatchRenamePlan,
  DEFAULT_ADD_TEXT_OPTIONS,
  DEFAULT_FIND_REPLACE_OPTIONS,
  DEFAULT_FORMAT_OPTIONS,
} from "./lib/batch-rename";
import type {
  AddTextOptions,
  BatchRenameMode,
  FindReplaceOptions,
  FormatOptions,
} from "./lib/batch-rename";

type RenameableNode = FrameNode | TextNode | SVGNode | ComponentInstanceNode;

const isRenameableNode = (node: CanvasNode): node is RenameableNode =>
  node instanceof FrameNode ||
  node instanceof TextNode ||
  node instanceof SVGNode ||
  node instanceof ComponentInstanceNode;

const nodeTypeLabel = (node: RenameableNode): string => {
  if (node instanceof FrameNode) {
    return "Frame";
  }
  if (node instanceof TextNode) {
    return "Text";
  }
  if (node instanceof SVGNode) {
    return "SVG";
  }
  return "Component instance";
};

const MODE_LABELS: Record<BatchRenameMode, string> = {
  addText: "Add text",
  findReplace: "Find & replace",
  format: "Format",
};

export const BatchRenamePanel = () => {
  const [selection, setSelection] = useState<CanvasNode[]>([]);
  const [mode, setMode] = useState<BatchRenameMode>("findReplace");
  const [findReplaceOptions, setFindReplaceOptions] =
    useState<FindReplaceOptions>(DEFAULT_FIND_REPLACE_OPTIONS);
  const [addTextOptions, setAddTextOptions] = useState<AddTextOptions>(
    DEFAULT_ADD_TEXT_OPTIONS
  );
  const [formatOptions, setFormatOptions] = useState<FormatOptions>(
    DEFAULT_FORMAT_OPTIONS
  );
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const loadInitialSelection = async () => {
      const initial = await framer.getSelection();
      // oxlint-disable-next-line react/react-compiler
      setSelection(initial);
    };
    void loadInitialSelection();
    return framer.subscribeToSelection(setSelection);
  }, []);

  const renameableNodes = useMemo(
    () => selection.filter(isRenameableNode),
    [selection]
  );
  const unsupportedCount = selection.length - renameableNodes.length;

  const items = useMemo(
    () =>
      renameableNodes.map((node) => ({ id: node.id, name: node.name ?? "" })),
    [renameableNodes]
  );

  const modeOptions: Record<
    BatchRenameMode,
    FindReplaceOptions | AddTextOptions | FormatOptions
  > = {
    addText: addTextOptions,
    findReplace: findReplaceOptions,
    format: formatOptions,
  };
  const options = modeOptions[mode];

  const plan = useMemo(
    () => computeBatchRenamePlan(items, mode, options),
    [items, mode, options]
  );
  const changedCount = plan.filter((entry) => entry.changed).length;

  const applyRename = useCallback(async () => {
    const changedEntries = plan.filter((entry) => entry.changed);
    if (changedEntries.length === 0) {
      return;
    }

    setApplying(true);
    setStatus(null);
    const nodesById = new Map(
      renameableNodes.map((node) => [node.id, node] as const)
    );
    let renamed = 0;
    const failures: string[] = [];

    for (const entry of changedEntries) {
      const node = nodesById.get(entry.id);
      if (!node) {
        continue;
      }
      try {
        // The Framer plugin bridge doesn't tolerate a burst of concurrent
        // requests well — rename sequentially rather than with Promise.all.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await node.setAttributes({ name: entry.after });
        renamed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${entry.before}: ${message}`);
      }
    }

    setApplying(false);
    const summary =
      failures.length > 0
        ? `Renamed ${renamed} item(s), ${failures.length} failed.`
        : `Renamed ${renamed} item(s).`;
    setStatus(
      failures.length > 0 ? `${summary} ${failures.join("; ")}` : summary
    );
    await framer.notify(summary, {
      variant: failures.length > 0 ? "warning" : "success",
    });

    const refreshed = await framer.getSelection();
    setSelection(refreshed);
  }, [plan, renameableNodes]);

  return (
    <section className="panel">
      <div className="panel-topline">
        <div>
          <div className="panel-label">Batch rename</div>
          <div className="panel-muted">
            Select layers on the canvas, then rename them all at once — find and
            replace, add text, or apply sequential numbering.
          </div>
        </div>
        <button
          className="btn btn--primary btn--medium"
          disabled={applying || changedCount === 0}
          onClick={() => void applyRename()}
          type="button"
        >
          {applying ? "Renaming…" : `Rename ${changedCount} item(s)`}
        </button>
      </div>

      {selection.length === 0 ? (
        <p className="panel-muted">
          Nothing selected. Select one or more layers on the canvas to batch
          rename them.
        </p>
      ) : (
        <>
          {unsupportedCount > 0 ? (
            <p className="panel-muted">
              {unsupportedCount} selected item(s) can&apos;t be renamed and are
              excluded below.
            </p>
          ) : null}

          <div className="header-actions">
            {(Object.keys(MODE_LABELS) as BatchRenameMode[]).map((key) => (
              <button
                className={`btn${mode === key ? " btn--active" : ""}`}
                key={key}
                onClick={() => setMode(key)}
                type="button"
              >
                {MODE_LABELS[key]}
              </button>
            ))}
          </div>

          {mode === "findReplace" ? (
            <div className="check-grid">
              <label>
                <span>Find</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    setFindReplaceOptions((current) => ({
                      ...current,
                      find: event.target.value,
                    }))
                  }
                  type="text"
                  value={findReplaceOptions.find}
                />
              </label>
              <label>
                <span>Replace with</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    setFindReplaceOptions((current) => ({
                      ...current,
                      replace: event.target.value,
                    }))
                  }
                  type="text"
                  value={findReplaceOptions.replace}
                />
              </label>
              <label className="optimizer-checkbox">
                <input
                  checked={findReplaceOptions.matchCase}
                  onChange={(event) =>
                    setFindReplaceOptions((current) => ({
                      ...current,
                      matchCase: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                <span>Match case</span>
              </label>
            </div>
          ) : null}

          {mode === "addText" ? (
            <div className="check-grid">
              <label>
                <span>Text</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    setAddTextOptions((current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  type="text"
                  value={addTextOptions.text}
                />
              </label>
              <label>
                <span>Position</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    setAddTextOptions((current) => ({
                      ...current,
                      placement: event.target
                        .value as AddTextOptions["placement"],
                    }))
                  }
                  value={addTextOptions.placement}
                >
                  <option value="before">Before name</option>
                  <option value="after">After name</option>
                </select>
              </label>
            </div>
          ) : null}

          {mode === "format" ? (
            <div className="check-grid">
              <label>
                <span>Name</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    setFormatOptions((current) => ({
                      ...current,
                      baseName: event.target.value,
                    }))
                  }
                  type="text"
                  value={formatOptions.baseName}
                />
              </label>
              <label>
                <span>Where</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    setFormatOptions((current) => ({
                      ...current,
                      placement: event.target
                        .value as FormatOptions["placement"],
                    }))
                  }
                  value={formatOptions.placement}
                >
                  <option value="suffix">Name and number</option>
                  <option value="prefix">Number and name</option>
                </select>
              </label>
              <label>
                <span>Start number</span>
                <input
                  className="form-control"
                  min={0}
                  onChange={(event) =>
                    setFormatOptions((current) => ({
                      ...current,
                      startNumber: Number(event.target.value),
                    }))
                  }
                  type="number"
                  value={formatOptions.startNumber}
                />
              </label>
              <label>
                <span>Digits</span>
                <input
                  className="form-control"
                  max={6}
                  min={1}
                  onChange={(event) =>
                    setFormatOptions((current) => ({
                      ...current,
                      padding: Number(event.target.value),
                    }))
                  }
                  type="number"
                  value={formatOptions.padding}
                />
              </label>
              <label>
                <span>Separator</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    setFormatOptions((current) => ({
                      ...current,
                      separator: event.target.value,
                    }))
                  }
                  type="text"
                  value={formatOptions.separator}
                />
              </label>
            </div>
          ) : null}

          <div className="violation-list">
            {plan.map((entry, index) => (
              <article className="violation-card" key={entry.id}>
                <div>
                  <strong>{entry.after || "(empty name)"}</strong>
                  <span>
                    {nodeTypeLabel(renameableNodes[index])} · was &ldquo;
                    {entry.before || "(unnamed)"}&rdquo;
                  </span>
                </div>
              </article>
            ))}
          </div>

          {status ? (
            <pre className="report report--compact">{status}</pre>
          ) : null}
        </>
      )}
    </section>
  );
};
