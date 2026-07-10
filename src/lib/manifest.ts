export interface PropSchema {
  type: string;
  title?: string;
  defaultValue?: unknown;
  description?: string;
  options?: string[];
  optionTitles?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hidden?: boolean;
}

export interface PropDoc {
  name: string;
  type: string;
  description: string;
  required: boolean;
  source?: "typescript" | "framer";
  framerControlType?: string;
  hasFramerControl?: boolean;
}

export interface ManifestComponent {
  key: string;
  displayName: string;
  category: string;
  syncPath?: string;
  description: string;
  source?: "framer-project" | "manual-framer";
  isCanvas: boolean;
  framerUrl?: string;
  status: "stable" | "beta" | "deprecated";
  tags: string[];
  propSchema: Record<string, PropSchema> | null;
  propDocs?: PropDoc[];
  framerPropCount?: number;
  typescriptPropCount?: number;
  propCount: number;
}

export interface Manifest {
  generatedAt: string;
  totalComponents: number;
  categories: string[];
  components: Record<string, ManifestComponent>;
}

export interface CmsImportRow {
  Slug: string;
  Title: string;
  "Component Key": string;
  Slot: number;
  Category: string;
  Description: string;
  Status: string;
  Tags: string;
  "Framer URL": string;
  "Prop Count": number;
  "Framer Prop Count": number;
  "TypeScript Prop Count": number;
  "Props JSON": string;
  "Props Meta JSON": string;
  "Canvas Component": boolean;
}

const configuredManifestUrl = import.meta.env.VITE_MANIFEST_URL;

export function getDefaultManifestUrl(): string {
  if (configuredManifestUrl) {
    return configuredManifestUrl;
  }

  if (import.meta.env.DEV) {
    return new URL(
      "/component-manifest.json",
      window.location.origin
    ).toString();
  }

  return new URL("/component-manifest.json", window.location.origin).toString();
}

export function normalizeManifestUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return new URL(trimmed, window.location.origin).toString();
  } catch {
    return trimmed;
  }
}

export async function fetchManifest(manifestUrl: string): Promise<Manifest> {
  const url = new URL(manifestUrl, window.location.origin);
  url.searchParams.set("t", Date.now().toString());

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<Manifest>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function formatStatus(status: ManifestComponent["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function latestFramerUrl(component: ManifestComponent): string {
  return component.framerUrl ?? "";
}

function normalizeCategory(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Uncategorized";
}

function buildCategorySlotMap(
  components: ManifestComponent[]
): Map<string, number> {
  const grouped = new Map<string, ManifestComponent[]>();
  for (const component of components) {
    const category = normalizeCategory(component.category);
    const list = grouped.get(category) ?? [];
    list.push(component);
    grouped.set(category, list);
  }

  const slotByKey = new Map<string, number>();
  for (const [category, list] of [...grouped.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    void category;
    const sorted = [...list].toSorted((left, right) =>
      left.displayName.localeCompare(right.displayName)
    );
    sorted.forEach((component, index) => {
      slotByKey.set(component.key, (index % 30) + 1);
    });
  }

  return slotByKey;
}

function toDisplayPropDocs(propDocs: PropDoc[] | undefined) {
  return (propDocs ?? []).map(({ name, type, description, required }) => ({
    description,
    name,
    required,
    type,
  }));
}

export function buildCmsImportRows(manifest: Manifest): CmsImportRow[] {
  const components = Object.values(manifest.components);
  const slotByKey = buildCategorySlotMap(components);

  return components
    .toSorted((left, right) =>
      left.displayName.localeCompare(right.displayName)
    )
    .map((component) => ({
      "Canvas Component": component.isCanvas,
      Category: component.category,
      "Component Key": component.key,
      Description: component.description,
      "Framer Prop Count": component.framerPropCount ?? 0,
      "Framer URL": latestFramerUrl(component),
      "Prop Count": component.propCount,
      "Props JSON": JSON.stringify(toDisplayPropDocs(component.propDocs)),
      "Props Meta JSON": JSON.stringify(component.propDocs ?? []),
      Slot: slotByKey.get(component.key) ?? 1,
      Slug: slugify(component.displayName || component.key),
      Status: formatStatus(component.status),
      Tags: component.tags.join(", "),
      Title: component.displayName,
      "TypeScript Prop Count": component.typescriptPropCount ?? 0,
    }));
}

export function buildCmsImportJson(manifest: Manifest): string {
  return `${JSON.stringify(buildCmsImportRows(manifest), null, 2)}\n`;
}

function escapeCsvValue(value: string | number | boolean): string {
  const stringValue = String(value ?? "");
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export function buildCmsImportCsv(manifest: Manifest): string {
  const rows = buildCmsImportRows(manifest);
  const headers = [
    "Slug",
    "Title",
    "Component Key",
    "Slot",
    "Category",
    "Description",
    "Status",
    "Tags",
    "Framer URL",
    "Prop Count",
    "Framer Prop Count",
    "TypeScript Prop Count",
    "Props JSON",
    "Props Meta JSON",
    "Canvas Component",
  ] as const;

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => escapeCsvValue(row[header])).join(",")
    ),
  ];

  return `${lines.join("\n")}\n`;
}
