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

export function Preview() {
  return (
    <main className="plugin-root">
      <section className="header">
        <div>
          <div className="header-kicker">RoleModel Preflight</div>
          <h1 className="header-title">Framer project checks</h1>
          <p className="header-copy">
            Run a focused publishing pass for component health, links, copy,
            contrast, and breakpoint spacing directly from the Framer UI.
          </p>
        </div>
        <div className="header-actions">
          <button className="template-table__apply" type="button">
            Run Preflight
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
              <label className="template-card check-card" key={label}>
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
    </main>
  );
}
