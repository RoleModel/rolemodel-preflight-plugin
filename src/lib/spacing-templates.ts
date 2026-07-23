export interface SpacingBreakpoint {
  breakpoint: "mobile" | "tablet" | "desktop";
  paddingY: number;
  paddingX: number;
  gap: number;
  maxWidth: number | null;
}

export interface SpacingTemplate {
  id: string;
  name: string;
  description: string;
  breakpoints: SpacingBreakpoint[];
}

export const defaultSpacingTemplates: SpacingTemplate[] = [
  {
    breakpoints: [
      {
        breakpoint: "mobile",
        gap: 12,
        maxWidth: null,
        paddingX: 28,
        paddingY: 40,
      },
      {
        breakpoint: "tablet",
        gap: 24,
        maxWidth: 768,
        paddingX: 40,
        paddingY: 40,
      },
      {
        breakpoint: "desktop",
        gap: 24,
        maxWidth: 1200,
        paddingX: 40,
        paddingY: 80,
      },
    ],
    description:
      "Default RoleModel section rhythm across desktop, tablet, and mobile.",
    id: "rolemodel",
    name: "RoleModel",
  },
];

export const createSpacingTemplate = (
  template?: SpacingTemplate
): SpacingTemplate => {
  const id = crypto.randomUUID();
  if (template) {
    return {
      ...template,
      breakpoints: template.breakpoints.map((breakpoint) => ({
        ...breakpoint,
      })),
      id,
      name: `${template.name} copy`,
    };
  }

  return {
    breakpoints: [
      {
        breakpoint: "mobile",
        gap: 16,
        maxWidth: null,
        paddingX: 24,
        paddingY: 40,
      },
      {
        breakpoint: "tablet",
        gap: 24,
        maxWidth: 768,
        paddingX: 40,
        paddingY: 56,
      },
      {
        breakpoint: "desktop",
        gap: 24,
        maxWidth: 1200,
        paddingX: 40,
        paddingY: 80,
      },
    ],
    description: "A custom spacing system for this project.",
    id,
    name: "New template",
  };
};

const isSpacingBreakpoint = (
  value: unknown,
  breakpoint: SpacingBreakpoint["breakpoint"]
): value is SpacingBreakpoint => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SpacingBreakpoint>;
  return (
    candidate.breakpoint === breakpoint &&
    typeof candidate.gap === "number" &&
    Number.isFinite(candidate.gap) &&
    (candidate.maxWidth === null ||
      (typeof candidate.maxWidth === "number" &&
        Number.isFinite(candidate.maxWidth))) &&
    typeof candidate.paddingX === "number" &&
    Number.isFinite(candidate.paddingX) &&
    typeof candidate.paddingY === "number" &&
    Number.isFinite(candidate.paddingY)
  );
};

const isSpacingTemplate = (value: unknown): value is SpacingTemplate => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SpacingTemplate>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    typeof candidate.description !== "string" ||
    !Array.isArray(candidate.breakpoints)
  ) {
    return false;
  }

  const breakpoints = new Map(
    candidate.breakpoints.map((row) => [
      (row as Partial<SpacingBreakpoint>)?.breakpoint,
      row,
    ])
  );
  return (["mobile", "tablet", "desktop"] as const).every((breakpoint) =>
    isSpacingBreakpoint(breakpoints.get(breakpoint), breakpoint)
  );
};

export const parseSpacingTemplates = (
  value: string | null
): SpacingTemplate[] => {
  const cloneDefaults = (): SpacingTemplate[] =>
    defaultSpacingTemplates.map((template) => ({
      ...template,
      breakpoints: template.breakpoints.map((breakpoint) => ({
        ...breakpoint,
      })),
    }));

  if (!value) {
    return cloneDefaults();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(isSpacingTemplate)) {
      return cloneDefaults();
    }
    return parsed;
  } catch {
    return cloneDefaults();
  }
};

export const formatSpacingTemplateSummary = (
  template: SpacingTemplate
): string => {
  const lines = [
    `${template.name} spacing template`,
    template.description,
    "",
    ...template.breakpoints.map((row) => {
      const width = row.maxWidth === null ? "fluid" : `${row.maxWidth}px max`;
      return `${row.breakpoint}: padding ${row.paddingY}px ${row.paddingX}px, gap ${row.gap}px, ${width}`;
    }),
  ];

  return lines.join("\n");
};

export const formatSpacingTemplateJson = (template: SpacingTemplate): string =>
  `${JSON.stringify(template, null, 2)}\n`;

export const formatSpacingTemplateCss = (template: SpacingTemplate): string => {
  const lines = [
    `:root {`,
    `  --rm-spacing-template: "${template.name}";`,
    `}`,
    "",
    ...template.breakpoints.flatMap((row) => {
      const maxWidth = row.maxWidth === null ? null : `${row.maxWidth}px`;
      const prefix = `.rm-spacing-${template.id}--${row.breakpoint}`;
      const output = [
        `${prefix} {`,
        `  --rm-container-padding-y: ${row.paddingY}px;`,
        `  --rm-container-padding-x: ${row.paddingX}px;`,
        `  --rm-container-padding: ${row.paddingY}px ${row.paddingX}px;`,
        `  --rm-stack-gap: ${row.gap}px;`,
        `  --rm-section-gap: ${row.gap}px;`,
        `}`,
      ];

      if (!maxWidth) {
        return output;
      }

      return [
        `@media (min-width: ${maxWidth}) {`,
        ...output.map((line) => `  ${line}`),
        `}`,
      ];
    }),
  ];

  return `${lines.join("\n")}\n`;
};
