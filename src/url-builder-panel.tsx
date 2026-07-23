import React, { useMemo, useState } from "react";

import { buildQueryUrl, parseUrl } from "./lib/url-builder";
import type { QueryParam } from "./lib/url-builder";

interface ParamRow extends QueryParam {
  id: string;
}

let rowIdCounter = 0;
const nextRowId = (): string => {
  rowIdCounter += 1;
  return `param-${rowIdCounter}`;
};

const DEFAULT_ROWS: ParamRow[] = [
  { id: nextRowId(), key: "utm_source", value: "" },
  { id: nextRowId(), key: "utm_medium", value: "" },
  { id: nextRowId(), key: "utm_campaign", value: "" },
];

export const UrlBuilderPanel = () => {
  const [baseUrl, setBaseUrl] = useState("");
  const [rows, setRows] = useState<ParamRow[]>(DEFAULT_ROWS);
  const [loadUrlInput, setLoadUrlInput] = useState("");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const builtUrl = useMemo(() => buildQueryUrl(baseUrl, rows), [baseUrl, rows]);

  const updateRow = (id: string, patch: Partial<QueryParam>) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  };

  const removeRow = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const addRow = () => {
    setRows((current) => [...current, { id: nextRowId(), key: "", value: "" }]);
  };

  const loadFromUrl = () => {
    if (!loadUrlInput.trim()) {
      return;
    }
    const parsed = parseUrl(loadUrlInput);
    setBaseUrl(parsed.baseUrl);
    setRows(
      parsed.params.length > 0
        ? parsed.params.map((param) => ({ ...param, id: nextRowId() }))
        : DEFAULT_ROWS
    );
    setLoadUrlInput("");
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(builtUrl);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Couldn't copy — select and copy the text manually.");
    }
    setTimeout(() => setCopyStatus(null), 2000);
  };

  return (
    <section className="panel">
      <div className="panel-topline">
        <div>
          <div className="panel-label">URL builder</div>
          <div className="panel-muted">
            Build a link with query params — each value is percent-encoded
            consistently (spaces as %20, apostrophes as %27) no matter what
            punctuation it contains.
          </div>
        </div>
      </div>

      <div className="check-grid">
        <label>
          <span>Load an existing URL (optional)</span>
          <input
            className="form-control"
            onChange={(event) => setLoadUrlInput(event.target.value)}
            placeholder="Paste a full URL to split it into base + params below"
            type="text"
            value={loadUrlInput}
          />
        </label>
      </div>
      <div className="header-actions">
        <button
          className="btn"
          disabled={!loadUrlInput.trim()}
          onClick={loadFromUrl}
          type="button"
        >
          Load
        </button>
      </div>

      <div className="check-grid">
        <label>
          <span>Base URL</span>
          <input
            className="form-control"
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="/consultation"
            type="text"
            value={baseUrl}
          />
        </label>
      </div>

      <div className="panel-label">Params</div>
      {rows.map((row) => (
        <div className="panel" key={row.id} style={{ gap: 6, padding: 10 }}>
          <div className="header-actions">
            <input
              className="form-control"
              onChange={(event) =>
                updateRow(row.id, { key: event.target.value })
              }
              placeholder="key, e.g. hero"
              type="text"
              value={row.key}
            />
            <button
              className="btn"
              onClick={() => removeRow(row.id)}
              type="button"
            >
              Remove
            </button>
          </div>
          <textarea
            className="form-control"
            onChange={(event) =>
              updateRow(row.id, { value: event.target.value })
            }
            placeholder="value — any text, including full sentences and punctuation"
            rows={row.value.length > 60 ? 3 : 1}
            value={row.value}
          />
        </div>
      ))}
      <div className="header-actions">
        <button className="btn" onClick={addRow} type="button">
          + Add param
        </button>
      </div>

      <div className="panel-label">Result</div>
      <textarea className="form-control" readOnly rows={3} value={builtUrl} />
      <div className="header-actions">
        <button
          className="btn btn--primary btn--medium"
          disabled={!builtUrl}
          onClick={() => void copyUrl()}
          type="button"
        >
          Copy URL
        </button>
        {copyStatus ? <span className="panel-muted">{copyStatus}</span> : null}
      </div>
    </section>
  );
};
