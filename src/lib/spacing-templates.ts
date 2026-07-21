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

export const spacingTemplates: SpacingTemplate[] = [
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
