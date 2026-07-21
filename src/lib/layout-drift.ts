export interface LayoutNodeSummary {
  id: string;
  type: string;
  name?: string | null;
  componentName?: string | null;
  componentIdentifier?: string | null;
  width?: unknown;
  height?: unknown;
  text?: string | null;
}

export type LayoutDriftIssueKind = "fill-size" | "text-overflow-risk";

export interface LayoutDriftIssue {
  id: string;
  nodeId: string;
  title: string;
  reason: string;
  kind: LayoutDriftIssueKind;
  width?: string;
  height?: string;
}

const stringValue = (value: unknown): string => {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
};

const numericValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?px?$/u.test(value.trim())) {
    // These strings always carry a trailing unit suffix (e.g. "120px");
    // Number() would return NaN where parseFloat correctly strips the suffix.
    // oxlint-disable-next-line unicorn/prefer-number-coercion
    return Number.parseFloat(value);
  }
  return null;
};

const isFillLike = (value: unknown): boolean => {
  const normalized = stringValue(value).toLowerCase();
  return (
    normalized === "1fr" ||
    normalized === "100%" ||
    normalized === "fill" ||
    normalized === "stretch"
  );
};

const nodeLabel = (node: LayoutNodeSummary): string =>
  node.componentName ??
  node.componentIdentifier ??
  node.name ??
  `${node.type} ${node.id}`;

const isMediaComponent = (node: LayoutNodeSummary): boolean => {
  const label = `${node.componentName ?? ""} ${node.componentIdentifier ?? ""} ${node.name ?? ""}`;
  return /(?:vimeo|video|player|embed|iframe|media)/iu.test(label);
};

const compactText = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

export const findLayoutDriftIssues = (
  nodes: LayoutNodeSummary[]
): LayoutDriftIssue[] => {
  const issues: LayoutDriftIssue[] = [];

  for (const node of nodes) {
    const width = stringValue(node.width);
    const height = stringValue(node.height);

    if (isMediaComponent(node) && isFillLike(node.width)) {
      issues.push({
        height,
        id: `fill-width-${node.id}`,
        kind: "fill-size",
        nodeId: node.id,
        reason:
          "Media/player component width is set to fill. If this recently reset, pin a fixed width or max width before publishing.",
        title: `Fill width: ${nodeLabel(node)}`,
        width,
      });
    }

    if (isMediaComponent(node) && isFillLike(node.height)) {
      issues.push({
        height,
        id: `fill-height-${node.id}`,
        kind: "fill-size",
        nodeId: node.id,
        reason:
          "Media/player component height is set to fill. Check that it still respects the intended aspect ratio.",
        title: `Fill height: ${nodeLabel(node)}`,
        width,
      });
    }

    const text = typeof node.text === "string" ? compactText(node.text) : "";
    if (!text) {
      continue;
    }

    const measuredWidth = numericValue(node.width);
    const measuredHeight = numericValue(node.height);
    const estimatedSingleLineWidth = text.length * 7;
    const estimatedLines =
      measuredWidth && measuredWidth > 0
        ? Math.ceil(estimatedSingleLineWidth / measuredWidth)
        : 1;
    const estimatedHeight = estimatedLines * 20;
    const tooNarrow = Boolean(
      measuredWidth && text.length > 28 && measuredWidth < 180
    );
    const tooShort = Boolean(
      measuredHeight && estimatedLines > 1 && measuredHeight < estimatedHeight
    );

    if (tooNarrow || tooShort) {
      issues.push({
        height,
        id: `text-overflow-${node.id}`,
        kind: "text-overflow-risk",
        nodeId: node.id,
        reason: `Text may overflow its box: "${text.slice(0, 90)}${text.length > 90 ? "..." : ""}"`,
        title: `Text overflow risk: ${nodeLabel(node)}`,
        width,
      });
    }
  }

  return issues;
};

export const formatLayoutDriftReport = (issues: LayoutDriftIssue[]): string => {
  const lines = ["Layout drift"];

  if (issues.length === 0) {
    lines.push(
      "No fill-size media resets or obvious text overflow risks found."
    );
    return lines.join("\n");
  }

  lines.push(`${issues.length} layout issue(s) need review:`, "");
  for (const issue of issues.slice(0, 40)) {
    const size = [
      issue.width ? `width ${issue.width}` : "",
      issue.height ? `height ${issue.height}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `  • ${issue.title}${size ? ` (${size})` : ""}`,
      `      ${issue.reason}`
    );
  }
  if (issues.length > 40) {
    lines.push(`  … +${issues.length - 40} more layout issue(s)`);
  }
  return lines.join("\n");
};
