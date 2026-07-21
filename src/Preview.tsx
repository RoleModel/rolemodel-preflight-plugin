import React from "react";

const previewReport = `RoleModel Preflight

Optional checks
  Link checking: ready
  Color contrast: ready
  Spelling: ready
  Punctuation: ready

Canvas component instances: 3786 total, 281 distinct module URL(s).

No unresolved relative/codeFile imports in scanned RoleModel files.
No obvious nested anchor/link patterns in scanned RoleModel files.

Spacing templates
  Large section: 80px 40px, 24px gap
  Standard section: 40px 40px, 24px gap
  Compact section: 40px 28px, 12px gap`;

export const Preview = () => {
  const styleRows = [
    {
      count: 134,
      name: "h1",
      path: "/h1",
      tag: "h1",
      value: "DM Sans · 700 · normal",
    },
    {
      count: 24,
      name: "Display",
      path: "/Dark/Display",
      tag: "h1",
      value: "DM Sans · 400 · normal",
    },
    {
      count: 9,
      name: "Display",
      path: "/Academy/Display",
      tag: "h1",
      value: "DM Sans · 500 · normal",
    },
    {
      count: 30,
      name: "Display",
      path: "/Display",
      tag: "h1",
      value: "DM Sans · 600 · normal",
    },
  ];

  return (
    <main className="plugin-root">
      <section className="header">
        <div>
          <div className="header-kicker">RoleModel Preflight</div>
          <h1 className="header-title">Framer project checks</h1>
          <p className="header-copy">
            Run a focused publishing pass for component health, styles, copy,
            contrast, and breakpoint spacing directly from the Framer UI.
          </p>
        </div>
        <div className="header-actions">
          <button className="btn btn--primary" type="button">
            Run Preflight
          </button>
          <button className="btn btn--primary" type="button">
            Fonts
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-topline">
          <div>
            <div className="panel-label">Optional checks</div>
            <div className="panel-muted">Enable heavier checks as needed.</div>
          </div>
        </div>
        <div className="check-grid">
          {["Link checking", "Color contrast", "Spelling", "Punctuation"].map(
            (label) => (
              <label
                aria-label={label}
                className="template-card check-card"
                key={label}
              >
                <span className="template-card__header">
                  <span>
                    <strong>{label}</strong>
                    <span>Included in the team preflight checklist.</span>
                  </span>
                  <input defaultChecked type="checkbox" />
                </span>
              </label>
            )
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-topline">
          <div>
            <div className="panel-label">Latest report</div>
            <div className="panel-muted">Preview data for screenshots.</div>
          </div>
          <span className="template-card__badge">Ready</span>
        </div>
        <div className="violation-list" aria-label="Actionable violations">
          <article className="violation-card">
            <div>
              <strong>WARNING link: CTA button (QltYy4fEy)</strong>
              <span># - Placeholder link.</span>
            </div>
            <div className="violation-card__actions">
              <button className="btn btn--primary" type="button">
                Go to
              </button>
              <button className="btn btn--primary" type="button">
                Clear link
              </button>
            </div>
          </article>
          <article className="violation-card">
            <div>
              <strong>Punctuation: Hero copy (b3Xf7qpB0)</strong>
              <span>Repeated punctuation. Build better software...</span>
            </div>
            <div className="violation-card__actions">
              <button className="btn btn--primary" type="button">
                Go to
              </button>
              <button className="btn btn--primary" disabled type="button">
                No fix
              </button>
            </div>
          </article>
        </div>
        <pre className="report">{previewReport}</pre>
      </section>

      <section className="panel">
        <div className="panel-topline">
          <div>
            <div className="panel-label">Spacing templates</div>
            <div className="panel-muted">
              Apply approved padding and gap patterns across breakpoints.
            </div>
          </div>
        </div>
        <div className="template-grid">
          {[
            ["Large section", "80 / 40", "24"],
            ["Standard section", "40 / 40", "24"],
            ["Compact section", "40 / 28", "12"],
          ].map(([name, padding, gap]) => (
            <article className="template-card" key={name}>
              <div className="template-card__header">
                <span>
                  <strong>{name}</strong>
                  <span>
                    Padding {padding}px with a {gap}px gap.
                  </span>
                </span>
                <span className="template-card__badge">Template</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel font-manager-shell">
        <div className="panel-topline">
          <div>
            <div className="panel-label">Font styles</div>
            <div className="panel-muted">
              Left list, right inspector, direct edit.
            </div>
          </div>
          <div className="font-manager__actions">
            <button className="btn" type="button">
              Refresh
            </button>
            <button className="btn btn--primary" type="button">
              Export JSON
            </button>
          </div>
        </div>
        <div className="font-manager__statusbar">
          <span className="font-manager__status">Loaded 42 text styles</span>
          <span className="font-manager__status">Editing h1</span>
        </div>
        <div className="font-manager__workspace">
          <aside className="font-manager__sidebar">
            <div className="font-manager__sidebar-head">
              <input className="font-manager__input" defaultValue="h1" />
              <div className="font-manager__sidebar-meta">
                <span>42 styles</span>
                <span>134 instances</span>
              </div>
            </div>
            <div className="font-manager__list">
              {styleRows.map((row, index) => (
                <button
                  aria-label={`${row.name} ${row.path}`}
                  className={`font-manager__row${index === 0 ? " font-manager__row--selected" : ""}`}
                  key={`${row.name}-${row.path}`}
                  type="button"
                >
                  <div className="font-manager__row-main">
                    <strong>{row.name}</strong>
                    <span>{row.path}</span>
                    <span>{row.value}</span>
                  </div>
                  <div className="font-manager__row-meta">
                    <span className="font-manager__badge">{row.tag}</span>
                    <span className="font-manager__count">{row.count}</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>
          <section className="font-manager__editor">
            <div className="font-manager__editor-head">
              <div>
                <div className="font-manager__editor-title">h1</div>
                <div className="font-manager__editor-subtitle">
                  /h1 · h1 · 134 instance(s)
                </div>
              </div>
              <div className="font-manager__editor-actions">
                <button className="btn" type="button">
                  Go to instance
                </button>
                <button className="btn" type="button">
                  Select instances
                </button>
              </div>
            </div>

            <div className="font-manager__preview">
              <div className="font-manager__preview-label">Current values</div>
              <pre className="font-manager__preview-code">
                {`{
  "font": "DM Sans · 700 · normal",
  "color": "White",
  "breakpoints": 4,
  "letterSpacing": -0.04,
  "lineHeight": 1.1,
  "paragraphSpacing": 0
}`}
              </pre>
            </div>

            <div className="font-manager__field-grid">
              {[
                ["Font", "DM Sans"],
                ["Weight", "700"],
                ["Style", "Normal"],
                ["Color", "White"],
                ["Size", "134"],
                ["Letter", "-0.04"],
                ["Line", "1.1"],
                ["Paragraph", "0"],
              ].map(([label, value]) => (
                <label className="font-manager__field" key={label}>
                  <span>{label}</span>
                  <input className="font-manager__input" defaultValue={value} />
                </label>
              ))}
            </div>

            <div className="font-manager__breakpoints">
              <div className="panel-topline">
                <div>
                  <div className="panel-label">Breakpoints</div>
                  <div className="panel-muted">
                    Match the responsive controls shown in the screenshot.
                  </div>
                </div>
                <button className="btn" type="button">
                  Add breakpoint
                </button>
              </div>

              <div className="font-manager__breakpoint-head">
                <span>Min width</span>
                <span>Size</span>
                <span>Letter</span>
                <span>Line</span>
                <span>Paragraph</span>
                <span />
              </div>
              <div className="font-manager__breakpoint-list">
                {[
                  [1600, 134, -0.04, 1.1, 0],
                  [1200, 116, -0.03, 1.08, 0],
                  [768, 88, -0.02, 1.06, 0],
                ].map(([minWidth, size, letter, line, paragraph]) => (
                  <div
                    className="font-manager__breakpoint-row"
                    key={String(minWidth)}
                  >
                    <input
                      className="font-manager__input"
                      defaultValue={String(minWidth)}
                    />
                    <input
                      className="font-manager__input"
                      defaultValue={String(size)}
                    />
                    <input
                      className="font-manager__input"
                      defaultValue={String(letter)}
                    />
                    <input
                      className="font-manager__input"
                      defaultValue={String(line)}
                    />
                    <input
                      className="font-manager__input"
                      defaultValue={String(paragraph)}
                    />
                    <button className="btn btn--ghost" type="button">
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="font-manager__footer">
              <button className="btn btn--primary" type="button">
                Save style
              </button>
              <button className="btn" type="button">
                Reload
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
};
