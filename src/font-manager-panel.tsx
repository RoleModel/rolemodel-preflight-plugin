import { framer } from "@framer/plugin";
import type { Font, TextStyle } from "@framer/plugin";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { formatFontLibraryExport, snapshotTextStyle } from "./lib/font-library";

interface FontManagerPanelProps {
  onOpenProjectCleanup?: () => void;
}

type FontStyleValue = "normal" | "italic";
type FontWeightValue = (typeof DEFAULT_WEIGHTS)[number];

interface BreakpointDraft {
  minWidth: number;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  paragraphSpacing: number;
}

interface StyleDraft {
  fontFamily: string;
  fontWeight: number;
  fontStyle: FontStyleValue;
  colorMode: "style" | "custom";
  colorStyleId: string;
  colorValue: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  paragraphSpacing: number;
  breakpoints: BreakpointDraft[];
}

interface StyleRow {
  style: TextStyle;
  usageCount: number;
}

const DEFAULT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    // Number.parseFloat (not Number()) is intentional: this defensively
    // normalizes values Framer's API typically returns as plain numbers,
    // but a stray unit suffix (e.g. "12px") must still parse to 12 rather
    // than fail closed to the fallback.
    // oxlint-disable-next-line unicorn/prefer-number-coercion
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const isColorStyle = (
  value: unknown
): value is {
  id: string;
  name: string;
  light: string;
} =>
  Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).name === "string"
  );

const describeFont = (font: Font | null | undefined): string => {
  if (!font) {
    return "";
  }

  const family = font.family?.trim() || font.selector?.trim() || "Unknown";
  const parts = [family];
  if (typeof font.weight === "number") {
    parts.push(String(font.weight));
  }
  if (typeof font.style === "string") {
    parts.push(font.style);
  }
  return parts.join(" · ");
};

const collectFamilyFonts = (fonts: Font[]): Map<string, Font[]> => {
  const map = new Map<string, Font[]>();
  for (const font of fonts) {
    const family = font.family?.trim() || font.selector?.trim();
    if (!family) {
      continue;
    }
    const list = map.get(family) ?? [];
    list.push(font);
    map.set(family, list);
  }

  for (const [family, list] of map) {
    list.sort((left, right) => {
      const leftWeight = typeof left.weight === "number" ? left.weight : 0;
      const rightWeight = typeof right.weight === "number" ? right.weight : 0;
      if (leftWeight !== rightWeight) {
        return leftWeight - rightWeight;
      }
      return String(left.style ?? "").localeCompare(String(right.style ?? ""));
    });
    map.set(family, list);
  }

  return map;
};

const resolveFont = async (
  family: string,
  weight: FontWeightValue,
  style: FontStyleValue,
  familyFonts: Map<string, Font[]>
): Promise<Font | null> => {
  const trimmedFamily = family.trim();
  if (!trimmedFamily) {
    return null;
  }

  const candidate = familyFonts
    .get(trimmedFamily)
    ?.find(
      (font) =>
        (typeof font.weight !== "number" || font.weight === weight) &&
        (font.style ?? "normal") === style
    );
  if (candidate) {
    return candidate;
  }

  const sameFamily = familyFonts.get(trimmedFamily)?.find((font) => {
    const fontWeight = typeof font.weight === "number" ? font.weight : 0;
    return fontWeight === weight;
  });
  if (sameFamily) {
    return sameFamily;
  }

  try {
    return await framer.getFont(trimmedFamily, { style, weight });
  } catch {
    return null;
  }
};

const styleToDraft = (
  style: TextStyle,
  colorStyles: { id: string; name: string; light: string }[]
): StyleDraft => {
  const { color } = style;
  const currentColorStyle = isColorStyle(color) ? color : null;
  const colorStyle = currentColorStyle?.id
    ? (colorStyles.find((entry) => entry.id === currentColorStyle.id) ?? null)
    : null;

  return {
    breakpoints: style.breakpoints.map((breakpoint) => ({
      fontSize: toNumber(breakpoint.fontSize, toNumber(style.fontSize, 0)),
      letterSpacing: toNumber(
        breakpoint.letterSpacing,
        toNumber(style.letterSpacing, 0)
      ),
      lineHeight: toNumber(
        breakpoint.lineHeight,
        toNumber(style.lineHeight, 1)
      ),
      minWidth: breakpoint.minWidth,
      paragraphSpacing: toNumber(
        breakpoint.paragraphSpacing,
        style.paragraphSpacing ?? 0
      ),
    })),
    colorMode: colorStyle ? "style" : "custom",
    colorStyleId: colorStyle?.id ?? "",
    colorValue:
      typeof color === "string"
        ? color
        : (colorStyle?.light ?? currentColorStyle?.light ?? "#000000"),
    fontFamily: style.font.family?.trim() || style.font.selector?.trim() || "",
    fontSize: toNumber(style.fontSize, 0),
    fontStyle: (style.font.style ?? "normal") as FontStyleValue,
    fontWeight: clampNumber(
      toNumber(style.font.weight, 400),
      DEFAULT_WEIGHTS[0],
      DEFAULT_WEIGHTS.at(-1) ?? 900
    ) as FontWeightValue,
    letterSpacing: toNumber(style.letterSpacing, 0),
    lineHeight: toNumber(style.lineHeight, 1),
    paragraphSpacing: toNumber(style.paragraphSpacing, 0),
  };
};

const downloadTextFile = async (
  filename: string,
  contents: string
): Promise<void> => {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        excludeAcceptAllOption?: boolean;
        suggestedName?: string;
        types?: {
          accept: Record<string, string[]>;
          description: string;
        }[];
      }) => Promise<{
        createWritable: () => Promise<{
          close: () => Promise<void>;
          write: (value: Blob) => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [
        {
          accept: { "application/json": [".json"] },
          description: "JSON file",
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([contents], { type: "application/json" }));
    await writable.close();
    return;
  }

  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const FontManagerPanel = ({
  onOpenProjectCleanup,
}: FontManagerPanelProps) => {
  const [styles, setStyles] = useState<TextStyle[]>([]);
  const [fonts, setFonts] = useState<Font[]>([]);
  const [colorStyles, setColorStyles] = useState<
    { id: string; name: string; light: string }[]
  >([]);
  const [styleRows, setStyleRows] = useState<StyleRow[]>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<string>("");
  const [draft, setDraft] = useState<StyleDraft | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);

  const familyFonts = useMemo(() => collectFamilyFonts(fonts), [fonts]);
  const familyNames = useMemo(
    () =>
      [...familyFonts.keys()].toSorted((left, right) =>
        left.localeCompare(right)
      ),
    [familyFonts]
  );
  const weightOptions = useMemo(() => {
    const weights = new Set<number>(DEFAULT_WEIGHTS);
    const selectedFamilyFonts = familyFonts.get(draft?.fontFamily ?? "");
    for (const font of selectedFamilyFonts ?? []) {
      if (typeof font.weight === "number") {
        weights.add(font.weight);
      }
    }
    return [...weights].toSorted((left, right) => left - right);
  }, [draft?.fontFamily, familyFonts]);

  const selectedStyle = useMemo(
    () => styles.find((style) => style.id === selectedStyleId) ?? null,
    [selectedStyleId, styles]
  );

  const selectedRow = useMemo(
    () => styleRows.find((row) => row.style.id === selectedStyleId) ?? null,
    [selectedStyleId, styleRows]
  );

  const loadProject = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectStyles, projectFonts, projectColors, projectTextNodes] =
        await Promise.all([
          framer.getTextStyles(),
          framer.getFonts(),
          framer.getColorStyles(),
          framer.getNodesWithType("TextNode"),
        ]);

      const usageCounts = new Map<string, number>();
      for (const node of projectTextNodes) {
        const styleId = node.inlineTextStyle?.id;
        if (!styleId) {
          continue;
        }
        usageCounts.set(styleId, (usageCounts.get(styleId) ?? 0) + 1);
      }

      setStyles(projectStyles);
      setFonts(projectFonts);
      setColorStyles(
        projectColors
          .map((entry) => ({
            id: entry.id,
            light: entry.light,
            name: entry.name,
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name))
      );
      setStyleRows(
        projectStyles.map((style) => ({
          style,
          usageCount: usageCounts.get(style.id) ?? 0,
        }))
      );
      setSelectedStyleId((current) => {
        if (current && projectStyles.some((style) => style.id === current)) {
          return current;
        }
        return projectStyles.at(0)?.id ?? "";
      });
      setStatus(`Loaded ${projectStyles.length} text styles`);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      setStatus("Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch-on-mount: synchronizes local state with the Framer project on
  // first render (and whenever loadProject's identity changes).
  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler
    void loadProject();
  }, [loadProject]);

  // Derives the edit draft from whichever style is currently selected —
  // a legitimate "reset state when a dependency changes" effect.
  useEffect(() => {
    if (!selectedStyle) {
      // oxlint-disable-next-line react/react-compiler
      setDraft(null);
      return;
    }
    // oxlint-disable-next-line react/react-compiler
    setDraft(styleToDraft(selectedStyle, colorStyles));
  }, [colorStyles, selectedStyle]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return styleRows;
    }

    return styleRows.filter((row) => {
      const searchable = [
        row.style.name,
        row.style.path,
        row.style.tag,
        describeFont(row.style.font),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [search, styleRows]);

  const updateDraft = useCallback(
    <Key extends keyof StyleDraft>(key: Key, value: StyleDraft[Key]) => {
      setDraft((current) => {
        if (!current) {
          return current;
        }
        return { ...current, [key]: value };
      });
    },
    []
  );

  const updateBreakpoint = useCallback(
    (index: number, key: keyof BreakpointDraft, value: number) => {
      setDraft((current) => {
        if (!current) {
          return current;
        }
        const next = current.breakpoints.map((breakpoint, currentIndex) =>
          currentIndex === index ? { ...breakpoint, [key]: value } : breakpoint
        );
        return { ...current, breakpoints: next };
      });
    },
    []
  );

  const addBreakpoint = useCallback(() => {
    setDraft((current) => {
      if (!current || current.breakpoints.length >= 4) {
        return current;
      }
      return {
        ...current,
        breakpoints: [
          ...current.breakpoints,
          {
            fontSize: current.fontSize,
            letterSpacing: current.letterSpacing,
            lineHeight: current.lineHeight,
            minWidth: 0,
            paragraphSpacing: current.paragraphSpacing,
          },
        ],
      };
    });
  }, []);

  const removeBreakpoint = useCallback((index: number) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        breakpoints: current.breakpoints.filter(
          (_, currentIndex) => currentIndex !== index
        ),
      };
    });
  }, []);

  const setSelectedStyleFromRow = useCallback((row: StyleRow) => {
    setSelectedStyleId(row.style.id);
    setStatus(`Editing ${row.style.name}`);
  }, []);

  const goToStyleInstances = useCallback(async () => {
    if (!selectedStyle) {
      return;
    }
    const nodes = await framer.getNodesWithType("TextNode");
    const matching = nodes.filter(
      (node) => node.inlineTextStyle?.id === selectedStyle.id
    );
    if (matching.length === 0) {
      await framer.notify("No text nodes use this style yet.", {
        variant: "warning",
      });
      return;
    }

    await matching
      .at(0)
      ?.navigateTo({ select: true, zoomIntoView: { maxZoom: 1 } });
  }, [selectedStyle]);

  const selectStyleInstances = useCallback(async () => {
    if (!selectedStyle) {
      return;
    }
    const nodes = await framer.getNodesWithType("TextNode");
    const matching = nodes.filter(
      (node) => node.inlineTextStyle?.id === selectedStyle.id
    );
    if (matching.length === 0) {
      await framer.notify("No text nodes use this style yet.", {
        variant: "warning",
      });
      return;
    }

    await framer.setSelection(matching.map((node) => node.id));
    await framer.notify(`Selected ${matching.length} instance(s).`, {
      variant: "success",
    });
  }, [selectedStyle]);

  const saveStyle = useCallback(async () => {
    if (!selectedStyle || !draft) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const baseFont = await resolveFont(
        draft.fontFamily,
        draft.fontWeight as FontWeightValue,
        draft.fontStyle,
        familyFonts
      );
      if (!baseFont) {
        throw new Error(`No font found for ${draft.fontFamily}.`);
      }

      const boldFont = await resolveFont(
        draft.fontFamily,
        700 as FontWeightValue,
        "normal",
        familyFonts
      );
      const italicFont = await resolveFont(
        draft.fontFamily,
        draft.fontWeight as FontWeightValue,
        "italic",
        familyFonts
      );
      const boldItalicFont = await resolveFont(
        draft.fontFamily,
        700 as FontWeightValue,
        "italic",
        familyFonts
      );

      const breakpoints = draft.breakpoints
        .filter((breakpoint) => Number.isFinite(breakpoint.minWidth))
        .map((breakpoint) => ({
          fontSize: breakpoint.fontSize,
          letterSpacing: breakpoint.letterSpacing,
          lineHeight: breakpoint.lineHeight,
          minWidth: breakpoint.minWidth,
          paragraphSpacing: breakpoint.paragraphSpacing,
        }))
        .toSorted((left, right) => right.minWidth - left.minWidth);

      const update: Record<string, unknown> = {
        boldFont,
        boldItalicFont,
        breakpoints,
        color:
          draft.colorMode === "style"
            ? (colorStyles.find((entry) => entry.id === draft.colorStyleId) ??
              draft.colorValue)
            : draft.colorValue,
        font: baseFont,
        fontSize: draft.fontSize,
        italicFont,
        letterSpacing: draft.letterSpacing,
        lineHeight: draft.lineHeight,
        paragraphSpacing: draft.paragraphSpacing,
      };

      await selectedStyle.setAttributes(update as never);
      await loadProject();
      setStatus(`Saved ${selectedStyle.name}`);
      await framer.notify(`Updated ${selectedStyle.name}.`, {
        variant: "success",
      });
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      setStatus("Save failed");
      await framer.notify(message, { variant: "error" });
    } finally {
      setSaving(false);
    }
  }, [colorStyles, draft, familyFonts, loadProject, selectedStyle]);

  const exportPack = useCallback(async () => {
    const contents = formatFontLibraryExport(styles, []);
    const filename = "framer-text-styles.json";
    try {
      await downloadTextFile(filename, contents);
      setStatus("Export saved");
      await framer.notify("Exported text style snapshot.", {
        variant: "success",
      });
    } catch (exportError) {
      const message =
        exportError instanceof Error
          ? exportError.message
          : String(exportError);
      setError(message);
      setStatus("Export failed");
      await framer.notify(message, { variant: "error" });
    }
  }, [styles]);

  const selectedPreview = useMemo(() => {
    if (!selectedStyle) {
      return null;
    }
    return snapshotTextStyle(selectedStyle);
  }, [selectedStyle]);

  return (
    <section className="panel font-manager-shell">
      <div className="panel-topline font-manager__topline">
        <div>
          <div className="panel-label">Text styles</div>
          <div className="panel-muted">
            Edit the selected style directly and push the change back to Framer.
          </div>
        </div>
        <div className="font-manager__actions">
          <button
            className="btn"
            onClick={() => void loadProject()}
            type="button"
          >
            Refresh
          </button>
          <button
            className="btn btn--primary"
            onClick={() => void exportPack()}
            type="button"
          >
            Export JSON
          </button>
          <button className="btn" onClick={onOpenProjectCleanup} type="button">
            Project cleanup
          </button>
        </div>
      </div>

      <div className="font-manager__statusbar">
        <span className="font-manager__status">{status}</span>
        {loading ? (
          <span className="font-manager__status">Loading project data…</span>
        ) : null}
        {error ? (
          <span className="font-manager__status font-manager__status--error">
            {error}
          </span>
        ) : null}
      </div>

      <div className="font-manager__workspace">
        <aside className="font-manager__sidebar">
          <div className="font-manager__sidebar-head">
            <input
              aria-label="Search text styles"
              className="font-manager__input"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search styles"
              value={search}
            />
            <div className="font-manager__sidebar-meta">
              <span>{styleRows.length} styles</span>
              <span>{selectedRow?.usageCount ?? 0} instances</span>
            </div>
          </div>

          {/* Not a real <ul>: children are <button>s laid out with CSS grid
              gap, and swapping to <ul>/<li> would need a layout rework to
              verify visually rather than a blind markup change. */}
          <div
            className="font-manager__list"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="list"
            aria-label="Text styles"
          >
            {filteredRows.map((row) => {
              const isSelected = row.style.id === selectedStyleId;
              return (
                <button
                  aria-label={row.style.name}
                  aria-pressed={isSelected}
                  className={`font-manager__row${isSelected ? " font-manager__row--selected" : ""}`}
                  key={row.style.id}
                  onClick={() => setSelectedStyleFromRow(row)}
                  type="button"
                >
                  <div className="font-manager__row-main">
                    <strong>{row.style.name}</strong>
                    <span>{row.style.path || row.style.tag}</span>
                    <span>{describeFont(row.style.font)}</span>
                  </div>
                  <div className="font-manager__row-meta">
                    <span className="font-manager__badge">{row.style.tag}</span>
                    <span className="font-manager__count">
                      {row.usageCount}
                    </span>
                  </div>
                </button>
              );
            })}
            {!loading && filteredRows.length === 0 ? (
              <div className="font-manager__empty">
                No styles match this filter.
              </div>
            ) : null}
          </div>
        </aside>

        <section className="font-manager__editor">
          {selectedStyle && draft ? (
            <>
              <div className="font-manager__editor-head">
                <div>
                  <div className="font-manager__editor-title">
                    {selectedStyle.name}
                  </div>
                  <div className="font-manager__editor-subtitle">
                    {selectedStyle.path || "Root"} · {selectedStyle.tag} ·{" "}
                    {selectedRow?.usageCount ?? 0} instance(s)
                  </div>
                </div>
                <div className="font-manager__editor-actions">
                  <button
                    className="btn"
                    onClick={() => void goToStyleInstances()}
                    type="button"
                  >
                    Go to instance
                  </button>
                  <button
                    className="btn"
                    onClick={() => void selectStyleInstances()}
                    type="button"
                  >
                    Select instances
                  </button>
                </div>
              </div>

              {selectedPreview ? (
                <div className="font-manager__preview">
                  <div className="font-manager__preview-label">
                    Current values
                  </div>
                  <pre className="font-manager__preview-code">
                    {JSON.stringify(
                      {
                        breakpoints: selectedPreview.breakpoints.length,
                        color: selectedPreview.color,
                        font: selectedPreview.font,
                        letterSpacing: selectedPreview.letterSpacing,
                        lineHeight: selectedPreview.lineHeight,
                        paragraphSpacing: selectedPreview.paragraphSpacing,
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              ) : null}

              <div className="font-manager__field-grid">
                <label className="font-manager__field">
                  <span>Font</span>
                  <select
                    className="font-manager__input"
                    onChange={(event) =>
                      updateDraft("fontFamily", event.target.value)
                    }
                    value={draft.fontFamily}
                  >
                    {familyNames.map((family) => (
                      <option key={family} value={family}>
                        {family}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="font-manager__field">
                  <span>Weight</span>
                  <select
                    className="font-manager__input"
                    onChange={(event) =>
                      updateDraft("fontWeight", Number(event.target.value))
                    }
                    value={draft.fontWeight}
                  >
                    {weightOptions.map((weight) => (
                      <option key={weight} value={weight}>
                        {weight}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="font-manager__field">
                  <span>Style</span>
                  <select
                    className="font-manager__input"
                    onChange={(event) =>
                      updateDraft(
                        "fontStyle",
                        event.target.value as FontStyleValue
                      )
                    }
                    value={draft.fontStyle}
                  >
                    <option value="normal">Normal</option>
                    <option value="italic">Italic</option>
                  </select>
                </label>

                <label className="font-manager__field">
                  <span>Color</span>
                  <select
                    className="font-manager__input"
                    onChange={(event) => {
                      const nextId = event.target.value;
                      if (nextId === "__custom__") {
                        updateDraft("colorMode", "custom");
                        return;
                      }
                      const nextStyle = colorStyles.find(
                        (entry) => entry.id === nextId
                      );
                      updateDraft("colorMode", "style");
                      updateDraft("colorStyleId", nextStyle?.id ?? "");
                      updateDraft(
                        "colorValue",
                        nextStyle?.light ?? draft.colorValue
                      );
                    }}
                    value={
                      draft.colorMode === "style"
                        ? draft.colorStyleId
                        : "__custom__"
                    }
                  >
                    <option value="__custom__">Custom color</option>
                    {colorStyles.map((colorStyle) => (
                      <option key={colorStyle.id} value={colorStyle.id}>
                        {colorStyle.name}
                      </option>
                    ))}
                  </select>
                </label>

                {draft.colorMode === "custom" ? (
                  <label className="font-manager__field font-manager__field--wide">
                    <span>Custom color value</span>
                    <input
                      className="font-manager__input"
                      onChange={(event) =>
                        updateDraft("colorValue", event.target.value)
                      }
                      value={draft.colorValue}
                    />
                  </label>
                ) : null}

                <label className="font-manager__field">
                  <span>Size</span>
                  <input
                    className="font-manager__input"
                    min={0}
                    onChange={(event) =>
                      updateDraft("fontSize", Number(event.target.value))
                    }
                    step="1"
                    type="number"
                    value={draft.fontSize}
                  />
                </label>

                <label className="font-manager__field">
                  <span>Letter</span>
                  <input
                    className="font-manager__input"
                    onChange={(event) =>
                      updateDraft("letterSpacing", Number(event.target.value))
                    }
                    step="0.01"
                    type="number"
                    value={draft.letterSpacing}
                  />
                </label>

                <label className="font-manager__field">
                  <span>Line</span>
                  <input
                    className="font-manager__input"
                    onChange={(event) =>
                      updateDraft("lineHeight", Number(event.target.value))
                    }
                    step="0.01"
                    type="number"
                    value={draft.lineHeight}
                  />
                </label>

                <label className="font-manager__field">
                  <span>Paragraph</span>
                  <input
                    className="font-manager__input"
                    min={0}
                    onChange={(event) =>
                      updateDraft(
                        "paragraphSpacing",
                        Number(event.target.value)
                      )
                    }
                    step="1"
                    type="number"
                    value={draft.paragraphSpacing}
                  />
                </label>
              </div>

              <div className="font-manager__breakpoints">
                <div className="panel-topline">
                  <div>
                    <div className="panel-label">Breakpoints</div>
                    <div className="panel-muted">
                      Edit responsive overrides for this text style.
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={draft.breakpoints.length >= 4}
                    onClick={() => void addBreakpoint()}
                    type="button"
                  >
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
                  {draft.breakpoints.map((breakpoint, index) => (
                    <div
                      className="font-manager__breakpoint-row"
                      key={`${breakpoint.minWidth}-${index}`}
                    >
                      <input
                        className="font-manager__input"
                        min={0}
                        onChange={(event) =>
                          updateBreakpoint(
                            index,
                            "minWidth",
                            Number(event.target.value)
                          )
                        }
                        step="1"
                        type="number"
                        value={breakpoint.minWidth}
                      />
                      <input
                        className="font-manager__input"
                        onChange={(event) =>
                          updateBreakpoint(
                            index,
                            "fontSize",
                            Number(event.target.value)
                          )
                        }
                        step="1"
                        type="number"
                        value={breakpoint.fontSize}
                      />
                      <input
                        className="font-manager__input"
                        onChange={(event) =>
                          updateBreakpoint(
                            index,
                            "letterSpacing",
                            Number(event.target.value)
                          )
                        }
                        step="0.01"
                        type="number"
                        value={breakpoint.letterSpacing}
                      />
                      <input
                        className="font-manager__input"
                        onChange={(event) =>
                          updateBreakpoint(
                            index,
                            "lineHeight",
                            Number(event.target.value)
                          )
                        }
                        step="0.01"
                        type="number"
                        value={breakpoint.lineHeight}
                      />
                      <input
                        className="font-manager__input"
                        min={0}
                        onChange={(event) =>
                          updateBreakpoint(
                            index,
                            "paragraphSpacing",
                            Number(event.target.value)
                          )
                        }
                        step="1"
                        type="number"
                        value={breakpoint.paragraphSpacing}
                      />
                      <button
                        className="btn btn--ghost"
                        onClick={() => removeBreakpoint(index)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {draft.breakpoints.length === 0 ? (
                    <div className="font-manager__empty">
                      No overrides yet. Add a breakpoint if you need one.
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="font-manager__footer">
                <button
                  className="btn btn--primary"
                  onClick={() => void saveStyle()}
                  disabled={saving}
                  type="button"
                >
                  {saving ? "Saving…" : "Save style"}
                </button>
                <button
                  className="btn"
                  onClick={() => void loadProject()}
                  type="button"
                >
                  Reload
                </button>
              </div>
            </>
          ) : (
            <div className="font-manager__empty">
              {loading
                ? "Loading styles…"
                : "No text styles found in this project."}
            </div>
          )}
        </section>
      </div>
    </section>
  );
};
