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
        paddingY: 40,
        paddingX: 28,
        gap: 12,
        maxWidth: null,
      },
      {
        breakpoint: "tablet",
        paddingY: 40,
        paddingX: 40,
        gap: 24,
        maxWidth: 768,
      },
      {
        breakpoint: "desktop",
        paddingY: 80,
        paddingX: 40,
        gap: 24,
        maxWidth: 1200,
      },
    ],
    description:
      "Default RoleModel section rhythm across desktop, tablet, and mobile.",
    id: "rolemodel",
    name: "RoleModel",
  },
];

export function formatSpacingTemplateSummary(
  template: SpacingTemplate
): string {
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
}

export function formatSpacingTemplateJson(template: SpacingTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

export function formatSpacingTemplateCss(template: SpacingTemplate): string {
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
}
