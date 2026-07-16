import { framer } from "framer-plugin";
import React, { useCallback, useMemo, useState } from "react";

import { ImageOptimizerPanel } from "./ImageOptimizerPanel";
import {
  analyzeCanvasImages,
  analyzeCodePerformance,
  runPageSpeedAudit,
} from "./lib/performance-audit";
import type {
  PerformanceFinding,
  PerformanceMetrics,
} from "./lib/performance-audit";

const DEFAULT_SITE_URL = "https://rolemodelsoftware.com/";
const RUNTIME_SCAN_BATCH_SIZE = 40;

interface AuditCoverage {
  codeFiles: number;
  componentInstances: number;
  distinctModuleUrls: number;
  frameImages: number;
  runtimeErrors: number;
  runtimeScanAvailable: boolean;
}

interface RuntimeErrorReader {
  getRuntimeErrorForCodeComponentNode?: (
    nodeId: string
  ) => Promise<{ message: string; type: string } | null>;
}

interface PerformancePanelProps {
  onOpenProjectCleanup?: () => void;
}

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

function buildCanvasTargets(
  rows: readonly { id: string; label: string }[]
): { id: string; label: string }[] {
  const targets = new Map<string, string>();
  for (const row of rows) {
    if (!targets.has(row.id)) {
      targets.set(row.id, row.label);
    }
  }
  const labelTotals = new Map<string, number>();
  for (const label of targets.values()) {
    labelTotals.set(label, (labelTotals.get(label) ?? 0) + 1);
  }
  const labelIndexes = new Map<string, number>();
  return [...targets].map(([id, label]) => {
    const index = (labelIndexes.get(label) ?? 0) + 1;
    labelIndexes.set(label, index);
    return {
      id,
      label: (labelTotals.get(label) ?? 0) > 1 ? `${label} ${index}` : label,
    };
  });
}

async function resolveStableCanvasNodeId(
  nodeId: string
): Promise<string | null> {
  let currentNode = await framer.getNode(nodeId);
  let depth = 0;

  while (currentNode?.isReplica && depth < 12) {
    currentNode = await currentNode.getParent();
    depth += 1;
  }

  return currentNode?.id ?? null;
}

export function PerformancePanel({
  onOpenProjectCleanup,
}: PerformancePanelProps) {
  const [siteUrl, setSiteUrl] = useState(DEFAULT_SITE_URL);
  const [apiKey, setApiKey] = useState("");
  const [metrics, setMetrics] = useState<PerformanceMetrics>({});
  const [findings, setFindings] = useState<PerformanceFinding[]>([]);
  const [coverage, setCoverage] = useState<AuditCoverage | null>(null);
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

      const [codeFiles, componentInstances, frameNodes, webPages] =
        await Promise.all([
          framer.getCodeFiles(),
          framer.getNodesWithType("ComponentInstanceNode"),
          framer.getNodesWithType("FrameNode"),
          framer.getNodesWithType("WebPageNode"),
        ]);
      const projectResult = analyzeCodePerformance(
        codeFiles.map((file) => ({ content: file.content, path: file.path }))
      );
      setStatus(
        `Checking runtime errors across ${componentInstances.length.toLocaleString()} component instances…`
      );
      const runtimeRows: {
        instance: (typeof componentInstances)[number];
        message: string;
        type: string;
      }[] = [];
      const runtimeErrorReader = (framer as unknown as RuntimeErrorReader)
        .getRuntimeErrorForCodeComponentNode;
      if (runtimeErrorReader) {
        for (
          let index = 0;
          index < componentInstances.length;
          index += RUNTIME_SCAN_BATCH_SIZE
        ) {
          const batch = componentInstances.slice(
            index,
            index + RUNTIME_SCAN_BATCH_SIZE
          );
          const results = await Promise.all(
            batch.map(async (instance) => {
              try {
                const runtimeError = await runtimeErrorReader.call(
                  framer,
                  instance.id
                );
                return runtimeError ? { instance, runtimeError } : null;
              } catch {
                return null;
              }
            })
          );
          for (const result of results) {
            if (!result) {
              continue;
            }
            runtimeRows.push({
              instance: result.instance,
              message: result.runtimeError.message,
              type: result.runtimeError.type,
            });
          }
        }
      }

      const runtimeGroups = new Map<string, typeof runtimeRows>();
      for (const row of runtimeRows) {
        const key = `${row.instance.insertURL ?? row.instance.componentIdentifier}\n${row.message}`;
        const group = runtimeGroups.get(key) ?? [];
        group.push(row);
        runtimeGroups.set(key, group);
      }
      const runtimeFindings = await Promise.all(
        [...runtimeGroups.entries()].map(async ([key, rows], groupIndex) => {
          const resolvedIds = await Promise.all(
            rows.map((row) =>
              resolveStableCanvasNodeId(row.instance.id).catch(() => null)
            )
          );
          const stableIds = [
            ...new Set(resolvedIds.filter((id): id is string => id !== null)),
          ];
          const first = rows[0];
          const canvasTargets = buildCanvasTargets(
            rows.flatMap((row, index) => {
              const id = resolvedIds[index];
              if (!id) {
                return [];
              }
              return [
                {
                  id,
                  label:
                    row.instance.name?.trim() ||
                    row.instance.componentName?.trim() ||
                    `Affected instance ${index + 1}`,
                },
              ];
            })
          );
          const message = first?.message ?? "Unknown runtime error";
          const missingLocalModule =
            /#framer\/local\/codeFile|Unable to resolve specifier/i.test(
              message
            );
          return {
            canvasInstanceCount: stableIds.length || rows.length,
            canvasNodeId: stableIds[0],
            canvasTargets,
            canvasTargetLabel: "Go to affected instance",
            detail: `${first?.instance.componentName ?? first?.instance.name ?? "Code component"}: ${message}`,
            id: `runtime-${groupIndex}-${key.slice(0, 80)}`,
            recommendation: missingLocalModule
              ? "Replace the affected legacy instance with the current published component, or republish its package after replacing project-local imports with published URLs."
              : "Go to the affected instance, then inspect or replace its source component. Use the runtime message above as the concrete failure to resolve.",
            severity: "critical" as const,
            title: `${first?.type ?? "Runtime error"} in mounted component`,
          };
        })
      );
      const actionableProjectFindings = await Promise.all(
        projectResult.findings.map(async (finding) => {
          if (!finding.codeFilePath) {
            return finding;
          }
          const codeFile = codeFiles.find(
            (file) => file.path === finding.codeFilePath
          );
          const insertUrls = new Set(
            codeFile?.exports.flatMap((codeExport) =>
              codeExport.type === "component" ? [codeExport.insertURL] : []
            )
          );
          const matchingInstances = componentInstances.filter(
            (instance) =>
              instance.insertURL !== null && insertUrls.has(instance.insertURL)
          );
          const resolvedInstanceIds = await Promise.all(
            matchingInstances.map((instance) =>
              resolveStableCanvasNodeId(instance.id).catch(() => null)
            )
          );
          const stableInstanceIds = [
            ...new Set(
              resolvedInstanceIds.filter((id): id is string => id !== null)
            ),
          ];
          const canvasTargets = buildCanvasTargets(
            matchingInstances.flatMap((instance, index) => {
              const id = resolvedInstanceIds[index];
              if (!id) {
                return [];
              }
              return [
                {
                  id,
                  label:
                    instance.name?.trim() ||
                    instance.componentName?.trim() ||
                    `Affected instance ${index + 1}`,
                },
              ];
            })
          );
          return {
            ...finding,
            canvasInstanceCount: stableInstanceIds.length || undefined,
            canvasNodeId: stableInstanceIds[0],
            canvasTargets,
            canvasTargetLabel: stableInstanceIds[0]
              ? "Go to affected instance"
              : undefined,
          };
        })
      );
      const canvasImageFindings = analyzeCanvasImages(
        frameNodes.flatMap((node) =>
          node.backgroundImage
            ? [
                {
                  id: node.id,
                  name: node.name,
                  url: node.backgroundImage.url,
                },
              ]
            : []
        )
      );
      setCoverage({
        codeFiles: codeFiles.length,
        componentInstances: componentInstances.length,
        distinctModuleUrls: new Set(
          componentInstances
            .map((instance) => instance.insertURL)
            .filter((url): url is string => url !== null)
        ).size,
        frameImages: frameNodes.filter((node) => node.backgroundImage).length,
        runtimeErrors: runtimeRows.length,
        runtimeScanAvailable: runtimeErrorReader !== undefined,
      });
      setStatus("Running the published mobile PageSpeed audit…");
      try {
        const pageSpeedResult = await runPageSpeedAudit(normalizedUrl, apiKey);
        const auditedPath = new URL(normalizedUrl).pathname.replace(/\/$/, "");
        const auditedPage = webPages.find(
          (page) => (page.path ?? "").replace(/\/$/, "") === auditedPath
        );
        const actionablePageSpeedFindings = pageSpeedResult.findings.map(
          (finding) => ({
            ...finding,
            pageNodeId: auditedPage?.id,
            pagePath: auditedPage?.path ?? undefined,
          })
        );
        const combined = sortFindings([
          ...actionablePageSpeedFindings,
          ...canvasImageFindings,
          ...runtimeFindings,
          ...actionableProjectFindings,
        ]);
        setMetrics(pageSpeedResult.metrics);
        setFindings(combined);
        setStatus(
          `Audit complete: ${combined.length} prioritized finding${combined.length === 1 ? "" : "s"}. No project content was changed.`
        );
      } catch (error) {
        setMetrics({});
        setFindings(
          sortFindings([
            ...canvasImageFindings,
            ...runtimeFindings,
            ...actionableProjectFindings,
          ])
        );
        const message = error instanceof Error ? error.message : String(error);
        setStatus(
          `Project scan complete. PageSpeed was unavailable (${message}). Add an API key or open the external report; local findings are still shown.`
        );
      }
    } catch (error) {
      setMetrics({});
      setFindings([]);
      setCoverage(null);
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

  const handleGoToNode = useCallback(async (nodeId: string, label: string) => {
    try {
      const stableNodeId = await resolveStableCanvasNodeId(nodeId);
      if (!stableNodeId) {
        throw new Error("Node not found");
      }
      await framer.navigateTo(stableNodeId, {
        select: true,
        zoomIntoView: true,
      });
    } catch {
      await framer.notify(
        `${label} is no longer available. Run the audit again to refresh its location.`,
        { variant: "error" }
      );
    }
  }, []);

  const handleGoToImage = useCallback(
    async (nodeId: string, imageUrl?: string) => {
      try {
        const stableNodeId = await resolveStableCanvasNodeId(nodeId);
        if (stableNodeId) {
          await framer.navigateTo(stableNodeId, {
            select: true,
            zoomIntoView: true,
          });
          return;
        }
      } catch {
        // The canvas may have regenerated a replica ID since the audit.
      }

      try {
        const frameNodes = await framer.getNodesWithType("FrameNode");
        const currentNode = frameNodes.find(
          (node) =>
            imageUrl !== undefined && node.backgroundImage?.url === imageUrl
        );
        const stableNodeId = currentNode
          ? await resolveStableCanvasNodeId(currentNode.id)
          : null;
        if (stableNodeId) {
          await framer.navigateTo(stableNodeId, {
            select: true,
            zoomIntoView: true,
          });
          return;
        }
      } catch {
        // Report one controlled error below after both navigation attempts.
      }

      await framer.notify(
        "That image instance changed after the audit. Run the audit again to refresh its canvas location.",
        { variant: "error" }
      );
    },
    []
  );

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

        {onOpenProjectCleanup ? (
          <div className="performance-actions">
            <button
              className="btn btn--primary btn--medium"
              onClick={onOpenProjectCleanup}
              type="button"
            >
              Open full project cleanup
            </button>
            <span className="panel-muted">
              Scan broken imports, component modules, layout drift, links,
              placeholders, and canvas instances.
            </span>
          </div>
        ) : null}

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

        {coverage ? (
          <div className="performance-coverage">
            <div className="panel-topline">
              <span className="panel-label">Scan coverage</span>
              <span className="panel-muted">Current branch and canvas</span>
            </div>
            <div className="performance-metrics">
              <div className="performance-metric">
                <span>Code files</span>
                <strong>{coverage.codeFiles.toLocaleString()}</strong>
              </div>
              <div className="performance-metric">
                <span>Instances</span>
                <strong>{coverage.componentInstances.toLocaleString()}</strong>
              </div>
              <div className="performance-metric">
                <span>Module URLs</span>
                <strong>{coverage.distinctModuleUrls.toLocaleString()}</strong>
              </div>
              <div className="performance-metric">
                <span>Image layers</span>
                <strong>{coverage.frameImages.toLocaleString()}</strong>
              </div>
              <div className="performance-metric">
                <span>Runtime errors</span>
                <strong>{coverage.runtimeErrors.toLocaleString()}</strong>
              </div>
            </div>
            {!coverage.runtimeScanAvailable ? (
              <p className="panel-muted">
                This Framer host does not expose mounted component runtime
                errors to plugins. Code, module URL, image, and PageSpeed scans
                still ran, but host-console errors cannot be attributed to an
                instance from this plugin session.
              </p>
            ) : coverage.runtimeErrors === 0 ? (
              <p className="panel-muted">
                No mounted component reported a runtime error through Framer’s
                plugin API. A missing-module error visible only in the host
                console is likely retained in Framer’s stale module graph;
                reload the project before auditing again.
              </p>
            ) : null}
          </div>
        ) : null}

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
                {finding.codeFilePath ? (
                  <p>
                    <strong>Source:</strong> {finding.codeFilePath}
                  </p>
                ) : null}
                <p>
                  <strong>Fix:</strong> {finding.recommendation}
                </p>
                <div className="performance-finding__actions">
                  {finding.canvasNodeId && finding.canvasImageUrl ? (
                    <button
                      className="template-table__apply"
                      onClick={() =>
                        void handleGoToImage(
                          finding.canvasNodeId as string,
                          finding.canvasImageUrl
                        )
                      }
                      type="button"
                    >
                      Go to image
                    </button>
                  ) : null}
                  {finding.canvasTargets?.map((target, index) => (
                    <button
                      className="template-table__apply"
                      key={target.id}
                      onClick={() =>
                        void handleGoToNode(
                          target.id,
                          `Affected instance ${index + 1}`
                        )
                      }
                      title={target.label}
                      type="button"
                    >
                      Go to {target.label}
                    </button>
                  ))}
                  {!finding.canvasTargets?.length &&
                  finding.canvasNodeId &&
                  finding.canvasTargetLabel ? (
                    <button
                      className="template-table__apply"
                      onClick={() =>
                        void handleGoToNode(
                          finding.canvasNodeId as string,
                          "That component instance"
                        )
                      }
                      type="button"
                    >
                      {finding.canvasTargetLabel}
                    </button>
                  ) : null}
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
                  {finding.pageNodeId ? (
                    <button
                      className="template-table__apply"
                      onClick={() =>
                        void handleGoToNode(
                          finding.pageNodeId as string,
                          "That page"
                        )
                      }
                      type="button"
                    >
                      Go to page
                      {finding.pagePath ? ` (${finding.pagePath})` : ""}
                    </button>
                  ) : null}
                </div>
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
