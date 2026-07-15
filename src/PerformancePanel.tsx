import { framer } from "framer-plugin";
import React, { useCallback, useMemo, useState } from "react";

import { ImageOptimizerPanel } from "./ImageOptimizerPanel";
import {
  analyzeCodePerformance,
  runPageSpeedAudit,
} from "./lib/performance-audit";
import type {
  PerformanceFinding,
  PerformanceMetrics,
} from "./lib/performance-audit";

const DEFAULT_SITE_URL = "https://rolemodelsoftware.com/";

function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Enter the published site URL first.");
  }
  return new URL(
    /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  ).toString();
}

function sortFindings(
  findings: readonly PerformanceFinding[]
): PerformanceFinding[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return [...findings].sort(
    (first, second) => rank[first.severity] - rank[second.severity]
  );
}

export function PerformancePanel() {
  const [siteUrl, setSiteUrl] = useState(DEFAULT_SITE_URL);
  const [apiKey, setApiKey] = useState("");
  const [metrics, setMetrics] = useState<PerformanceMetrics>({});
  const [findings, setFindings] = useState<PerformanceFinding[]>([]);
  const [status, setStatus] = useState(
    "Run an audit to inspect the published mobile experience and project code."
  );
  const [working, setWorking] = useState(false);

  const metricEntries = useMemo(
    () => [
      ["Performance", metrics.performanceScore?.toString()],
      ["LCP", metrics.lcp],
      ["FCP", metrics.fcp],
      ["TBT", metrics.tbt],
      ["CLS", metrics.cls],
      ["Transfer", metrics.totalBytes],
    ],
    [metrics]
  );

  const handleAudit = useCallback(async () => {
    setWorking(true);
    setStatus("Scanning project code and component instances…");
    try {
      const normalizedUrl = normalizeSiteUrl(siteUrl);
      setSiteUrl(normalizedUrl);

      const [codeFiles, componentInstances] = await Promise.all([
        framer.getCodeFiles(),
        framer.getNodesWithType("ComponentInstanceNode"),
      ]);
      const projectResult = analyzeCodePerformance(
        codeFiles.map((file) => ({ content: file.content, path: file.path })),
        componentInstances.length
      );

      setStatus("Running the published mobile PageSpeed audit…");
      try {
        const pageSpeedResult = await runPageSpeedAudit(normalizedUrl, apiKey);
        const combined = sortFindings([
          ...pageSpeedResult.findings,
          ...projectResult.findings,
        ]);
        setMetrics(pageSpeedResult.metrics);
        setFindings(combined);
        setStatus(
          `Audit complete: ${combined.length} prioritized finding${combined.length === 1 ? "" : "s"}. No project content was changed.`
        );
      } catch (error) {
        setMetrics({});
        setFindings(sortFindings(projectResult.findings));
        const message = error instanceof Error ? error.message : String(error);
        setStatus(
          `Project scan complete. PageSpeed was unavailable (${message}). Add an API key or open the external report; local findings are still shown.`
        );
      }
    } catch (error) {
      setMetrics({});
      setFindings([]);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }, [apiKey, siteUrl]);

  const handleOpenFile = useCallback(async (path: string) => {
    const codeFiles = await framer.getCodeFiles();
    const file = codeFiles.find((entry) => entry.path === path);
    if (!file) {
      await framer.notify(`Code file not found: ${path}`, { variant: "error" });
      return;
    }
    await file.navigateTo();
  }, []);

  const handleExternalReport = useCallback(() => {
    try {
      const normalizedUrl = normalizeSiteUrl(siteUrl);
      const reportUrl = new URL("https://pagespeed.web.dev/analysis");
      reportUrl.searchParams.set("url", normalizedUrl);
      reportUrl.searchParams.set("form_factor", "mobile");
      window.open(reportUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [siteUrl]);

  return (
    <div className="performance-dashboard">
      <section className="panel">
        <div className="panel-topline">
          <span className="panel-label">Performance audit</span>
          <button
            className="btn btn--primary btn--medium"
            disabled={working}
            onClick={() => void handleAudit()}
            type="button"
          >
            {working ? "Auditing…" : "Run performance audit"}
          </button>
        </div>

        <p className="panel-muted">
          Combines a mobile PageSpeed report with project-local checks for
          hidden first-frame text, heavy runtimes, and legacy image URLs.
        </p>

        <div className="performance-form">
          <label>
            <span>Published site URL</span>
            <input
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder="https://example.com/"
              type="url"
              value={siteUrl}
            />
          </label>
          <label>
            <span>PageSpeed API key (optional)</span>
            <input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Use when public quota is unavailable"
              type="password"
              value={apiKey}
            />
          </label>
        </div>

        <div className="performance-actions">
          <button className="btn" onClick={handleExternalReport} type="button">
            Open external mobile report
          </button>
          <span className="panel-muted">{status}</span>
        </div>

        {metricEntries.some(([, value]) => value !== undefined) ? (
          <div className="performance-metrics" aria-label="PageSpeed metrics">
            {metricEntries.map(([label, value]) => (
              <div className="performance-metric" key={label}>
                <span>{label}</span>
                <strong>{value ?? "—"}</strong>
              </div>
            ))}
          </div>
        ) : null}

        {findings.length > 0 ? (
          <div className="performance-findings">
            <div className="panel-topline">
              <span className="panel-label">Prioritized findings</span>
              <span className="panel-muted">Highest impact first</span>
            </div>
            {findings.map((finding) => (
              <article className="performance-finding" key={finding.id}>
                <div className="performance-finding__header">
                  <span
                    className={`performance-severity performance-severity--${finding.severity}`}
                  >
                    {finding.severity}
                  </span>
                  <strong>{finding.title}</strong>
                </div>
                <p>{finding.detail}</p>
                <p>
                  <strong>Fix:</strong> {finding.recommendation}
                </p>
                {finding.codeFilePath ? (
                  <button
                    className="template-table__apply"
                    onClick={() =>
                      void handleOpenFile(finding.codeFilePath as string)
                    }
                    type="button"
                  >
                    Open {finding.codeFilePath}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <div className="performance-safe-fixes">
        <div>
          <span className="panel-label">Safe fixes</span>
          <p className="panel-muted">
            Scan first, confirm the exact CMS scope, then replace supported
            source images. Unsupported formats are skipped without stopping the
            batch.
          </p>
        </div>
        <ImageOptimizerPanel />
      </div>
    </div>
  );
}
