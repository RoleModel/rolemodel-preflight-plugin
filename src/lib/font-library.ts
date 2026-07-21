import type { TextStyle } from "@framer/plugin";

export interface FontSnapshot {
  selector: string;
  family: string;
  weight: number | null;
  style: string | null;
}

export interface ColorSnapshot {
  id: string;
  name: string;
  path: string;
  light: string;
  dark: string | null;
}

export interface TextStyleBreakpointSnapshot {
  minWidth: number;
  fontSize: string | number;
  letterSpacing: string | number;
  lineHeight: string | number;
  paragraphSpacing: number;
}

export interface TextStyleSnapshot {
  id: string;
  name: string;
  path: string;
  tag: string;
  font: FontSnapshot;
  boldFont: FontSnapshot | null;
  italicFont: FontSnapshot | null;
  boldItalicFont: FontSnapshot | null;
  color: string | ColorSnapshot;
  transform: string;
  alignment: string;
  decoration: string;
  decorationColor: string | ColorSnapshot;
  decorationThickness: string | number;
  decorationStyle: string;
  decorationSkipInk: string;
  decorationOffset: string | number;
  balance: boolean;
  breakpoints: TextStyleBreakpointSnapshot[];
  minWidth: number;
  fontSize: string | number;
  letterSpacing: string | number;
  lineHeight: string | number;
  paragraphSpacing: number;
}

export interface FontLibraryExport {
  version: 1;
  generatedAt: string;
  approvedFontEntries: string[];
  styles: TextStyleSnapshot[];
}

export interface FontStyleRow extends TextStyleSnapshot {
  approved: boolean;
  styleScope: "style" | "node";
  matchReason: string;
}

const normalizeFontEntry = (value: string): string =>
  value.trim().toLowerCase().replaceAll(/\s+/gu, " ");

export const parseApprovedFontEntries = (value: string): string[] =>
  value
    .split(/[\n,]/u)
    .map((family) => family.trim())
    .filter(Boolean);

export const fontFamilyOf = (font: FontSnapshot | null | undefined): string =>
  font?.family?.trim() || font?.selector?.trim() || "";

export const fontDisplayLabel = (
  font: FontSnapshot | null | undefined
): string => {
  if (!font) {
    return "";
  }

  const family = font.family.trim();
  const selector = font.selector.trim();
  if (family && selector && selector !== family) {
    return `${family} (${selector})`;
  }

  return family || selector;
};

export const snapshotFont = (font: unknown): FontSnapshot | null => {
  if (!font || typeof font !== "object") {
    return null;
  }

  const record = font as Record<string, unknown>;
  const family = typeof record.family === "string" ? record.family : "";
  const selector = typeof record.selector === "string" ? record.selector : "";
  if (!family && !selector) {
    return null;
  }

  return {
    family,
    selector,
    style: typeof record.style === "string" ? record.style : null,
    weight:
      typeof record.weight === "number" && Number.isFinite(record.weight)
        ? record.weight
        : null,
  };
};

export const snapshotColorStyle = (value: unknown): ColorSnapshot | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  const path = typeof record.path === "string" ? record.path : "";
  const light = typeof record.light === "string" ? record.light : "";
  const dark = typeof record.dark === "string" ? record.dark : null;

  if (!id && !name && !path) {
    return null;
  }

  return { dark, id, light, name, path };
};

const snapshotBreakpoint = (
  value: unknown
): TextStyleBreakpointSnapshot | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const minWidth =
    typeof record.minWidth === "number" && Number.isFinite(record.minWidth)
      ? record.minWidth
      : null;
  if (minWidth === null) {
    return null;
  }

  return {
    fontSize:
      typeof record.fontSize === "number" || typeof record.fontSize === "string"
        ? record.fontSize
        : 0,
    letterSpacing:
      typeof record.letterSpacing === "number" ||
      typeof record.letterSpacing === "string"
        ? record.letterSpacing
        : 0,
    lineHeight:
      typeof record.lineHeight === "number" ||
      typeof record.lineHeight === "string"
        ? record.lineHeight
        : 0,
    minWidth,
    paragraphSpacing:
      typeof record.paragraphSpacing === "number" &&
      Number.isFinite(record.paragraphSpacing)
        ? record.paragraphSpacing
        : 0,
  };
};

const snapshotBreakpoints = (value: unknown): TextStyleBreakpointSnapshot[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const breakpoints = value
    .map((entry) => snapshotBreakpoint(entry))
    .filter((entry): entry is TextStyleBreakpointSnapshot => entry !== null);

  return breakpoints.toSorted((left, right) => right.minWidth - left.minWidth);
};

const normalizeStyleTag = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value : "p";

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const numberOrStringOr = (
  value: unknown,
  fallback: number | string
): number | string =>
  typeof value === "number" || typeof value === "string" ? value : fallback;

const finiteNumberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const colorSnapshotOr = (value: unknown): string | ColorSnapshot =>
  snapshotColorStyle(value) ?? stringOr(value, "");

const normalizeStyleFonts = (style: Record<string, unknown>) => ({
  boldFont: snapshotFont(style.boldFont),
  boldItalicFont: snapshotFont(style.boldItalicFont),
  font: snapshotFont(style.font) ?? {
    family: "",
    selector: "",
    style: null,
    weight: null,
  },
  italicFont: snapshotFont(style.italicFont),
});

const normalizeStyleDecoration = (style: Record<string, unknown>) => ({
  decoration: stringOr(style.decoration, "none"),
  decorationColor: colorSnapshotOr(style.decorationColor),
  decorationOffset: numberOrStringOr(style.decorationOffset, "auto"),
  decorationSkipInk: stringOr(style.decorationSkipInk, "auto"),
  decorationStyle: stringOr(style.decorationStyle, "solid"),
  decorationThickness: numberOrStringOr(style.decorationThickness, "auto"),
});

const normalizeTextStyleSnapshot = (
  style: Record<string, unknown>
): TextStyleSnapshot => ({
  alignment: stringOr(style.alignment, "left"),
  balance: Boolean(style.balance),
  breakpoints: snapshotBreakpoints(style.breakpoints),
  color: colorSnapshotOr(style.color),
  ...normalizeStyleDecoration(style),
  ...normalizeStyleFonts(style),
  fontSize: numberOrStringOr(style.fontSize, 0),
  id: stringOr(style.id, ""),
  letterSpacing: numberOrStringOr(style.letterSpacing, 0),
  lineHeight: numberOrStringOr(style.lineHeight, 0),
  minWidth: finiteNumberOr(style.minWidth, 0),
  name: stringOr(style.name, ""),
  paragraphSpacing: finiteNumberOr(style.paragraphSpacing, 0),
  path: stringOr(style.path, ""),
  tag: normalizeStyleTag(style.tag),
  transform: stringOr(style.transform, "none"),
});

export const snapshotTextStyle = (style: TextStyle): TextStyleSnapshot =>
  normalizeTextStyleSnapshot(style as unknown as Record<string, unknown>);

export const buildFontLibraryExport = (
  styles: readonly TextStyle[],
  approvedFontEntries: readonly string[]
): FontLibraryExport => ({
  approvedFontEntries: [...approvedFontEntries],
  generatedAt: new Date().toISOString(),
  styles: styles.map((style) => snapshotTextStyle(style)),
  version: 1,
});

export const formatFontLibraryExport = (
  styles: readonly TextStyle[],
  approvedFontEntries: readonly string[]
): string =>
  `${JSON.stringify(
    buildFontLibraryExport(styles, approvedFontEntries),
    null,
    2
  )}\n`;

export const parseFontLibraryExport = (value: string): FontLibraryExport => {
  const parsed = JSON.parse(value) as Partial<FontLibraryExport> & {
    styles?: unknown;
  };

  const approvedFontEntries = Array.isArray(parsed.approvedFontEntries)
    ? parsed.approvedFontEntries
        .map((family) => (typeof family === "string" ? family.trim() : ""))
        .filter(Boolean)
    : [];
  const styles = Array.isArray(parsed.styles)
    ? parsed.styles
        .map((style) => {
          if (!style || typeof style !== "object") {
            return null;
          }
          return normalizeTextStyleSnapshot(
            style as unknown as Record<string, unknown>
          );
        })
        .filter((style): style is TextStyleSnapshot => style !== null)
    : [];

  return {
    approvedFontEntries,
    generatedAt:
      typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    styles,
    version: parsed.version === 1 ? 1 : 1,
  };
};

export const compareFontSnapshotAgainstApproved = (
  font: FontSnapshot | null | undefined,
  approvedFontEntries: readonly string[]
): { approved: boolean; matchReason: string } => {
  if (!font) {
    return { approved: false, matchReason: "missing font" };
  }

  const approvedSet = new Set(
    approvedFontEntries.map((candidate) => normalizeFontEntry(candidate))
  );
  const selector = normalizeFontEntry(font.selector);
  if (selector && approvedSet.has(selector)) {
    return { approved: true, matchReason: font.selector };
  }

  const family = normalizeFontEntry(font.family);
  if (!selector && family && approvedSet.has(family)) {
    return { approved: true, matchReason: font.family };
  }

  return { approved: false, matchReason: "not on approved list" };
};

export const styleUsesApprovedFamily = (
  style: TextStyleSnapshot,
  approvedFontEntries: readonly string[]
): { approved: boolean; matchReason: string } => {
  const primary = compareFontSnapshotAgainstApproved(
    style.font,
    approvedFontEntries
  );
  if (primary.approved) {
    return primary;
  }

  const bold = style.boldFont
    ? compareFontSnapshotAgainstApproved(style.boldFont, approvedFontEntries)
    : null;
  if (bold?.approved) {
    return {
      approved: true,
      matchReason: `${bold.matchReason} (bold variant)`,
    };
  }

  const italic = style.italicFont
    ? compareFontSnapshotAgainstApproved(style.italicFont, approvedFontEntries)
    : null;
  if (italic?.approved) {
    return {
      approved: true,
      matchReason: `${italic.matchReason} (italic variant)`,
    };
  }

  const boldItalic = style.boldItalicFont
    ? compareFontSnapshotAgainstApproved(
        style.boldItalicFont,
        approvedFontEntries
      )
    : null;
  if (boldItalic?.approved) {
    return {
      approved: true,
      matchReason: `${boldItalic.matchReason} (bold italic variant)`,
    };
  }

  return { approved: false, matchReason: "not on approved list" };
};

export const styleSnapshotToAttributes = (
  style: TextStyleSnapshot
): Record<string, unknown> => ({
  alignment: style.alignment,
  balance: style.balance,
  boldFont: style.boldFont as never,
  boldItalicFont: style.boldItalicFont as never,
  breakpoints: style.breakpoints,
  color: style.color,
  decoration: style.decoration,
  decorationColor: style.decorationColor,
  decorationOffset: style.decorationOffset,
  decorationSkipInk: style.decorationSkipInk,
  decorationStyle: style.decorationStyle,
  decorationThickness: style.decorationThickness,
  font: style.font as never,
  fontSize: style.fontSize,
  italicFont: style.italicFont as never,
  letterSpacing: style.letterSpacing,
  lineHeight: style.lineHeight,
  minWidth: style.minWidth,
  paragraphSpacing: style.paragraphSpacing,
  path: style.path,
  tag: style.tag,
  transform: style.transform,
});
