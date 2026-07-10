import { framer } from "framer-plugin";
import React, { useCallback, useMemo, useState } from "react";

import { formatCanvasInstanceReport } from "./lib/canvas-instances";
import { analyzeCodeHealth, formatCodeHealthReport } from "./lib/code-health";
import {
  formatFramerLocalScanReport,
  scanCodeFileSourcesForFramerLocal,
  scanModuleUrlsForFramerLocal,
} from "./lib/scan-framer-local";
import {
  spacingTemplates,
  formatSpacingTemplateSummary,
} from "./lib/spacing-templates";
import type { SpacingBreakpoint } from "./lib/spacing-templates";
import {
  extractHref,
  findLinkLikeValues,
  formatTeamPreflightReport,
  runTeamPreflight,
} from "./lib/team-preflight";
import type {
  ContrastCandidate,
  ExternalLinkStatus,
  LinkCandidate,
  SpellingIssue,
  TeamPreflightOptions,
  TextCandidate,
} from "./lib/team-preflight";

interface DirectSyncFile {
  path: string;
  syncPath: string;
  content: string;
  uploadPath?: string;
}

interface PreflightSnapshot {
  report: string;
  issues: number;
  hasIssues: boolean;
}

interface ViolationAction {
  id: string;
  title: string;
  description: string;
  nodeId?: string;
  fix?: {
    label: string;
    type: "clearLink";
  };
}

type ScanSection = "preflight" | "spacing";

type OptionalCheckKey = keyof TeamPreflightOptions;

interface SpacingLayoutAttributes {
  padding: `${number}px ${number}px ${number}px ${number}px`;
  gap: `${number}px`;
}

const DEFAULT_TEAM_PREFLIGHT_OPTIONS: TeamPreflightOptions = {
  checkColorContrast: false,
  checkExternalLinks: false,
  checkPunctuation: true,
  checkSpelling: false,
};

function getSpacingLayoutAttributes(
  row: SpacingBreakpoint
): SpacingLayoutAttributes {
  return {
    gap: `${row.gap}px`,
    padding: `${row.paddingY}px ${row.paddingX}px ${row.paddingY}px ${row.paddingX}px`,
  };
}

function deriveProjectNodeBaseUrl(): string {
  const candidates = [window.location.href, document.referrer].filter(Boolean);
  for (const candidate of candidates) {
    const match = String(candidate).match(
      /(https:\/\/framer\.com\/projects\/[^?#]+)/
    );
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

async function scanCodeHealthSnapshot(): Promise<PreflightSnapshot> {
  const filesResponse = await fetch("/__repo/framer-sync-files");
  const filesPayload = (await filesResponse.json()) as {
    error?: string;
    files?: DirectSyncFile[];
  };

  if (!filesResponse.ok) {
    throw new Error(filesPayload.error ?? `HTTP ${filesResponse.status}`);
  }

  const syncFiles = filesPayload.files ?? [];
  if (syncFiles.length === 0) {
    throw new Error(
      "No generated sync files. Run Regenerate Sync Files from the repo first."
    );
  }

  const framerFiles = await framer.getCodeFiles();
  const report = analyzeCodeHealth({
    framerFiles: framerFiles.map((file) => ({
      path: file.path,
      name: file.name,
      content: file.content,
    })),
    syncFiles,
  });

  return {
    hasIssues:
      report.brokenRelativeImports.length > 0 || report.nestedLinks.length > 0,
    issues: report.brokenRelativeImports.length + report.nestedLinks.length,
    report: formatCodeHealthReport(report),
  };
}

async function scanCanvasInstancesSnapshot() {
  const instances = await framer.getNodesWithType("ComponentInstanceNode");
  const summary = instances.map((node) => ({
    componentIdentifier: node.componentIdentifier ?? "",
    componentName: node.componentName,
    id: node.id,
    insertURL: node.insertURL,
  }));
  const seedUrls = [
    ...new Set(summary.map((instance) => instance.insertURL).filter(Boolean)),
  ].filter((url): url is string => typeof url === "string");

  return {
    count: summary.length,
    instances: summary,
    report: formatCanvasInstanceReport(summary),
    seedUrls,
  };
}

async function scanRemoteImportsSnapshot(
  seedUrls: string[],
  instances: {
    id: string;
    insertURL: string | null;
    componentName?: string | null;
    componentIdentifier?: string | null;
  }[]
) {
  const moduleScanResult = await scanModuleUrlsForFramerLocal(seedUrls, {
    maxTotalFetches: 1200,
  });
  const framerFiles = await framer.getCodeFiles();
  const codeHits = scanCodeFileSourcesForFramerLocal(
    framerFiles.map((file) => ({
      content: file.content,
      name: file.name,
      path: file.path,
    }))
  );

  const report = formatFramerLocalScanReport({
    codeHits,
    instances,
    maxTotalFetches: moduleScanResult.maxTotalFetches,
    moduleScans: moduleScanResult.scans,
    projectNodeBaseUrl: deriveProjectNodeBaseUrl(),
    remainingQueue: moduleScanResult.remainingQueue,
    seedCount: seedUrls.length,
    truncated: moduleScanResult.truncated,
  });

  const hasIssues =
    moduleScanResult.scans.some(
      (scan) => scan.missing.length > 0 || !scan.ok || Boolean(scan.error)
    ) ||
    codeHits.some((hit) => hit.missing.length > 0 || hit.locals.length > 0);

  return {
    fetchCount: moduleScanResult.scans.length,
    hasIssues,
    report,
    truncated: moduleScanResult.truncated,
  };
}

function stringColor(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function getNodeTextIfAvailable(node: {
  getText?: () => Promise<string | null | undefined>;
}): Promise<string | null> {
  if (typeof node.getText !== "function") {
    return null;
  }

  try {
    return (await node.getText()) ?? null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("not a text node")
    ) {
      return null;
    }
    throw error;
  }
}

async function nearestBackgroundColor(node: {
  id: string;
}): Promise<string | null> {
  let parent = await framer.getParent(node.id);

  while (parent) {
    const backgroundColor = stringColor(
      (parent as { backgroundColor?: unknown }).backgroundColor
    );
    if (backgroundColor) {
      return backgroundColor;
    }
    parent = await framer.getParent(parent.id);
  }

  return null;
}

async function collectTeamPreflightInput() {
  const [pages, frameLinks, textLinks, textNodes, instances] =
    await Promise.all([
      framer.getNodesWithType("WebPageNode"),
      framer.getNodesWithAttributeSet("link"),
      framer.getNodesWithType("TextNode"),
      framer.getNodesWithType("TextNode"),
      framer.getNodesWithType("ComponentInstanceNode"),
    ]);

  const pagePaths = pages
    .map((page) => page.path)
    .filter((path): path is string => Boolean(path));
  const links: LinkCandidate[] = [];
  const texts: TextCandidate[] = [];
  const contrastPairs: ContrastCandidate[] = [];

  for (const node of frameLinks) {
    const href = extractHref((node as { link?: unknown }).link);
    if (!href) {
      continue;
    }
    links.push({
      canClearLink: true,
      nodeId: node.id,
      source: `${node.name ?? "Linked node"} (${node.id})`,
      value: href,
    });
  }

  for (const node of textLinks) {
    const href = extractHref(node.link);
    if (!href) {
      continue;
    }
    links.push({
      canClearLink: true,
      nodeId: node.id,
      source: `${node.name ?? "Linked text"} (${node.id})`,
      value: href,
    });
  }

  for (const instance of instances) {
    const { controls } = instance as { controls?: unknown };
    links.push(
      ...findLinkLikeValues(
        controls,
        `${instance.componentName ?? instance.componentIdentifier ?? "Component"} (${instance.id})`,
        instance.id
      )
    );
  }

  for (const node of textNodes) {
    const text = await getNodeTextIfAvailable(node);
    if (text?.trim()) {
      texts.push({
        nodeId: node.id,
        source: `${node.name ?? "Text"} (${node.id})`,
        text,
      });
    }

    const foreground = stringColor(
      (node.inlineTextStyle as { color?: unknown } | null)?.color
    );
    const background = await nearestBackgroundColor(node);
    if (foreground && background) {
      contrastPairs.push({
        background,
        foreground,
        nodeId: node.id,
        source: `${node.name ?? "Text"} (${node.id})`,
        text: text ?? undefined,
      });
    }
  }

  return {
    contrastPairs,
    links,
    pagePaths,
    texts,
  };
}

async function checkExternalLinks(
  urls: string[]
): Promise<Map<string, ExternalLinkStatus>> {
  const statuses = new Map<string, ExternalLinkStatus>();

  await Promise.all(
    urls.map(async (url) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);

      try {
        const response = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: controller.signal,
        });
        statuses.set(url, {
          ok: response.ok,
          status: response.status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statuses.set(url, {
          ok: false,
          reason: message.includes("abort")
            ? "External link check timed out."
            : "Could not verify external link from the plugin.",
          unverified: !message.includes("abort"),
        });
      } finally {
        window.clearTimeout(timeout);
      }
    })
  );

  return statuses;
}

async function checkSpelling(texts: TextCandidate[]): Promise<SpellingIssue[]> {
  const issues: SpellingIssue[] = [];
  const prose = texts
    .map((row) => ({ ...row, text: row.text.replaceAll(/\s+/g, " ").trim() }))
    .filter((row) => row.text.length >= 12);

  for (const row of prose.slice(0, 80)) {
    const body = new URLSearchParams({
      language: "en-US",
      text: row.text,
    });

    try {
      const response = await fetch("https://api.languagetool.org/v2/check", {
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as {
        matches?: {
          message?: string;
          offset?: number;
          length?: number;
          replacements?: { value?: string }[];
          rule?: { issueType?: string };
        }[];
      };

      for (const match of payload.matches ?? []) {
        if (match.rule?.issueType !== "misspelling") {
          continue;
        }
        const offset = match.offset ?? 0;
        const length = match.length ?? 0;
        issues.push({
          message: match.message ?? "Possible spelling issue",
          nodeId: row.nodeId,
          source: row.source,
          suggestions: (match.replacements ?? [])
            .map((replacement) => replacement.value)
            .filter((value): value is string => Boolean(value))
            .slice(0, 4),
          word: row.text.slice(offset, offset + length),
        });
      }
    } catch {
      issues.push({
        message: "LanguageTool could not be reached from the plugin.",
        nodeId: row.nodeId,
        source: row.source,
        suggestions: [],
        word: "(spellcheck unavailable)",
      });
      break;
    }
  }

  return issues;
}

function buildViolationActions(
  teamReport: Awaited<ReturnType<typeof runTeamPreflight>>
): ViolationAction[] {
  const actions: ViolationAction[] = [];

  for (const [index, issue] of teamReport.linkIssues.entries()) {
    actions.push({
      description: `${issue.href || "(empty)"} - ${issue.reason}`,
      fix: issue.canClearLink
        ? {
            label: "Clear link",
            type: "clearLink",
          }
        : undefined,
      id: `link-${index}-${issue.nodeId ?? "project"}`,
      nodeId: issue.nodeId,
      title: `${issue.severity.toUpperCase()} link: ${issue.source}`,
    });
  }

  for (const [index, issue] of teamReport.punctuationIssues.entries()) {
    actions.push({
      description: `${issue.reason} ${issue.text}`,
      id: `punctuation-${index}-${issue.nodeId ?? "project"}`,
      nodeId: issue.nodeId,
      title: `Punctuation: ${issue.source}`,
    });
  }

  for (const [index, issue] of teamReport.spellingIssues.entries()) {
    const suggestions =
      issue.suggestions.length > 0
        ? ` Suggestions: ${issue.suggestions.join(", ")}`
        : "";
    actions.push({
      description: `${issue.word} - ${issue.message}.${suggestions}`,
      id: `spelling-${index}-${issue.nodeId ?? "project"}`,
      nodeId: issue.nodeId,
      title: `Spelling: ${issue.source}`,
    });
  }

  for (const [index, issue] of teamReport.contrastIssues.entries()) {
    actions.push({
      description: `${issue.foreground} on ${issue.background} = ${issue.ratio.toFixed(2)}:1; needs ${issue.requiredRatio}:1.`,
      id: `contrast-${index}-${issue.nodeId ?? "project"}`,
      nodeId: issue.nodeId,
      title: `Contrast: ${issue.source}`,
    });
  }

  return actions;
}

export function App() {
  const [section, setSection] = useState<ScanSection>("preflight");
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    spacingTemplates[0]?.id ?? ""
  );
  const [applyingSpacing, setApplyingSpacing] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [teamOptions, setTeamOptions] = useState<TeamPreflightOptions>(
    DEFAULT_TEAM_PREFLIGHT_OPTIONS
  );
  const [report, setReport] = useState<string>(
    "Run Preflight to scan code health, canvas instances, and remote imports."
  );
  const [violationActions, setViolationActions] = useState<ViolationAction[]>(
    []
  );

  const selectedTemplate = useMemo(
    () =>
      spacingTemplates.find((template) => template.id === selectedTemplateId) ??
      spacingTemplates[0],
    [selectedTemplateId]
  );

  const handleApplySpacing = useCallback(
    async (row: SpacingBreakpoint, templateName: string) => {
      const applyKey = `${templateName}-${row.breakpoint}`;
      setApplyingSpacing(applyKey);

      try {
        const selection = await framer.getSelection();
        if (selection.length === 0) {
          await framer.notify(
            "Select one or more containers before applying spacing.",
            {
              variant: "warning",
            }
          );
          return;
        }

        const attributes = getSpacingLayoutAttributes(row);
        let applied = 0;
        let failed = 0;

        for (const node of selection) {
          try {
            await node.setAttributes(attributes as any);
            applied += 1;
          } catch {
            failed += 1;
          }
        }

        if (applied === 0) {
          await framer.notify(
            "Could not apply spacing to the current selection.",
            {
              variant: "error",
            }
          );
          return;
        }

        await framer.notify(
          `Applied ${row.breakpoint} spacing to ${applied} selected item${applied === 1 ? "" : "s"}${
            failed > 0 ? `; ${failed} failed` : ""
          }.`,
          { variant: failed > 0 ? "warning" : "success" }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await framer.notify(`Could not apply spacing: ${message}`, {
          variant: "error",
        });
      } finally {
        setApplyingSpacing(null);
      }
    },
    []
  );

  const handleRunPreflight = useCallback(async () => {
    if (scanning) {
      return;
    }

    setScanning(true);
    setReport("Running RoleModel preflight…");
    setViolationActions([]);

    try {
      const codeHealth = await scanCodeHealthSnapshot();
      const canvas = await scanCanvasInstancesSnapshot();
      const remote = await scanRemoteImportsSnapshot(
        canvas.seedUrls,
        canvas.instances
      );
      const teamInput = await collectTeamPreflightInput();
      const teamReport = await runTeamPreflight(teamInput, teamOptions, {
        checkExternalLinks,
        checkSpelling,
      });
      const issues = codeHealth.issues + (remote.hasIssues ? 1 : 0);

      const text = [
        "RoleModel Preflight",
        "",
        codeHealth.report.trim(),
        "",
        canvas.report.trim(),
        "",
        remote.report.trim(),
        "",
        formatTeamPreflightReport(teamReport, teamOptions).trim(),
      ].join("\n");

      setReport(text);
      setViolationActions(buildViolationActions(teamReport));
      await framer.notify(
        issues > 0
          ? `Preflight found ${issues} issue group(s).`
          : "Preflight passed with no unresolved code health or remote import issues.",
        { variant: issues > 0 ? "warning" : "success" }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReport(`RoleModel preflight failed: ${message}`);
      await framer.notify(`RoleModel preflight failed: ${message}`, {
        variant: "error",
      });
    } finally {
      setScanning(false);
    }
  }, [scanning, teamOptions]);

  const handleGoToViolation = useCallback(async (action: ViolationAction) => {
    if (!action.nodeId) {
      await framer.notify("This violation is not tied to a canvas node.", {
        variant: "info",
      });
      return;
    }

    try {
      const node = await framer.getNode(action.nodeId);
      if (!node) {
        await framer.notify("That canvas node no longer exists.", {
          variant: "warning",
        });
        return;
      }
      await node.navigateTo({ select: true, zoomIntoView: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await framer.notify(`Could not navigate to violation: ${message}`, {
        variant: "error",
      });
    }
  }, []);

  const handleFixViolation = useCallback(async (action: ViolationAction) => {
    if (!action.nodeId || action.fix?.type !== "clearLink") {
      await framer.notify("No automatic fix is available for this violation.", {
        variant: "info",
      });
      return;
    }

    try {
      const node = await framer.getNode(action.nodeId);
      if (!node) {
        await framer.notify("That canvas node no longer exists.", {
          variant: "warning",
        });
        return;
      }
      await node.setAttributes({ link: null } as any);
      await node.navigateTo({ select: true, zoomIntoView: true });
      await framer.notify("Cleared the broken link on the selected node.", {
        variant: "success",
      });
      setViolationActions((current) =>
        current.filter((row) => row.id !== action.id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await framer.notify(`Could not fix violation: ${message}`, {
        variant: "error",
      });
    }
  }, []);

  const toggleTeamOption = useCallback((key: OptionalCheckKey) => {
    setTeamOptions((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  return (
    <div className="plugin-root">
      <header className="header">
        <div>
          <div className="header-kicker">RoleModel</div>
          <h1 className="header-title">Preflight</h1>
          <p className="header-copy">
            Scan the current project for code health, canvas module references,
            and the bundle imports that break published components.
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => setSection("preflight")}>
            Preflight
          </button>
          <button className="btn" onClick={() => setSection("spacing")}>
            Spacing templates
          </button>
        </div>
      </header>

      {section === "preflight" ? (
        <section className="panel">
          <div className="panel-topline">
            <span className="panel-label">Project checks</span>
            <button
              className="btn btn--primary btn--medium"
              onClick={() => void handleRunPreflight()}
              disabled={scanning}
            >
              {scanning ? "Running…" : "Run Preflight"}
            </button>
          </div>

          <div
            className="op-grid op-grid--2-column"
            aria-label="Optional preflight checks"
          >
            <label className="card card--padded">
              <input
                checked={teamOptions.checkExternalLinks}
                onChange={() => toggleTeamOption("checkExternalLinks")}
                type="checkbox"
              />
              <p>
                <strong>Dead external links</strong>
              </p>
              <p>Slower; some hosts block browser verification.</p>
            </label>
            <label className="card card--padded">
              <input
                checked={teamOptions.checkColorContrast}
                onChange={() => toggleTeamOption("checkColorContrast")}
                type="checkbox"
              />
              <p>
                <strong>Color contrast</strong>
              </p>
              <p>Checks text color against detected parent background.</p>
            </label>
            <label className="card card--padded">
              <input
                checked={teamOptions.checkSpelling}
                onChange={() => toggleTeamOption("checkSpelling")}
                type="checkbox"
              />
              <p>
                <strong>Spelling</strong>
              </p>
              <p>Uses LanguageTool and sends scanned text for review.</p>
            </label>
            <label className="card card--padded">
              <input
                checked={teamOptions.checkPunctuation}
                onChange={() => toggleTeamOption("checkPunctuation")}
                type="checkbox"
              />
              <p>
                <strong>Punctuation</strong>
              </p>
              <p>Local checks for spacing, placeholders, and punctuation.</p>
            </label>
          </div>

          {violationActions.length > 0 ? (
            <div className="violation-list" aria-label="Actionable violations">
              <div className="panel-topline">
                <span className="panel-label">Actionable violations</span>
                <span className="panel-muted">
                  Jump to a problem or apply a safe fix when available.
                </span>
              </div>
              {violationActions.slice(0, 40).map((action) => (
                <article className="violation-card" key={action.id}>
                  <div>
                    <strong>{action.title}</strong>
                    <span>{action.description}</span>
                  </div>
                  <div className="violation-card__actions">
                    <button
                      className="template-table__apply"
                      disabled={!action.nodeId}
                      onClick={() => void handleGoToViolation(action)}
                      type="button"
                    >
                      Go to
                    </button>
                    <button
                      className="template-table__apply"
                      disabled={!action.fix}
                      onClick={() => void handleFixViolation(action)}
                      type="button"
                    >
                      {action.fix?.label ?? "No fix"}
                    </button>
                  </div>
                </article>
              ))}
              {violationActions.length > 40 ? (
                <p className="panel-muted">
                  Showing 40 of {violationActions.length} actionable violations.
                  Narrow the checks or fix the first batch, then run Preflight
                  again.
                </p>
              ) : null}
            </div>
          ) : null}

          <pre className="report">{report}</pre>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-topline">
            <span className="panel-label">Spacing templates</span>
            <span className="panel-muted">
              Aligned container spacing across mobile, tablet, and desktop.
            </span>
          </div>

          <div className="template-grid">
            {spacingTemplates.map((template) => {
              const isSelected = template.id === selectedTemplate?.id;

              return (
                <article
                  key={template.id}
                  className={`template-card${isSelected ? " template-card--selected" : ""}`}
                >
                  <button
                    className="template-card__header"
                    onClick={() => setSelectedTemplateId(template.id)}
                    type="button"
                  >
                    <span>
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </span>
                    <span className="template-card__badge">
                      {isSelected ? "Selected" : "Use"}
                    </span>
                  </button>

                  <div className="template-table">
                    <div className="template-table__head">
                      <span>Breakpoint</span>
                      <span>Padding Y</span>
                      <span>Padding X</span>
                      <span>Gap</span>
                      <span>Apply</span>
                    </div>
                    {template.breakpoints.map((row) => {
                      const applyKey = `${template.name}-${row.breakpoint}`;
                      const isApplying = applyingSpacing === applyKey;

                      return (
                        <div
                          className="template-table__row"
                          key={row.breakpoint}
                        >
                          <span>{row.breakpoint}</span>
                          <span>{row.paddingY}px</span>
                          <span>{row.paddingX}px</span>
                          <span>{row.gap}px</span>
                          <button
                            className="template-table__apply"
                            disabled={applyingSpacing !== null}
                            onClick={() =>
                              void handleApplySpacing(row, template.name)
                            }
                            type="button"
                          >
                            {isApplying ? "Applying" : "Apply"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>

          <pre className="report report--compact">
            {selectedTemplate
              ? formatSpacingTemplateSummary(selectedTemplate)
              : ""}
          </pre>
        </section>
      )}
    </div>
  );
}
