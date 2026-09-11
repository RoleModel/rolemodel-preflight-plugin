import type { PageKind, SchemaSiteConfig } from "./schema";

const SCHEMA_CONFIG_STORAGE_KEY = "rolemodel-preflight:schema-config";
const COLLECTION_MAP_STORAGE_KEY = "rolemodel-preflight:schema-collections";

/**
 * Seed values for the RoleModel site. These are starting points the panel lets
 * you edit — they are not authoritative, and the stored config always wins.
 */
export const DEFAULT_SCHEMA_CONFIG: SchemaSiteConfig = {
  address: {
    addressCountry: "US",
    addressLocality: "Apex",
    addressRegion: "NC",
    postalCode: "27539",
    streetAddress: "2141 E Williams St, Suite 204",
  },
  areaServed: ["US"],
  description:
    "RoleModel Software is a custom software development partner that builds software fitted to how a business actually works, in close collaboration with the people who run it.",
  email: "consult@rolemodelsoftware.com",
  foundingDate: "1997",
  knowsAbout: [
    "Custom software development",
    "Rules-driven configuration and quoting",
    "Design systems",
    "Software craftsmanship",
    "Web and mobile application development",
    "Developer apprenticeship",
  ],
  legalName: "RoleModel Software, Inc.",
  organizationName: "RoleModel Software",
  origin: "https://rolemodelsoftware.com",
  telephone: "+1-919-557-7550",
};

/** Which schema shape a CMS collection's items should get. */
export interface CollectionSchemaMapping {
  collectionId: string;
  collectionName: string;
  /** Path prefix the collection publishes under, e.g. "/case-studies". */
  pathPrefix: string;
  kind: PageKind;
  /** Field ids used to populate the graph. Empty string means "not mapped". */
  titleFieldId: string;
  descriptionFieldId: string;
  imageFieldId: string;
  datePublishedFieldId: string;
  bodyFieldId: string;
  /** Text field the generated JSON-LD is written back into (optional path). */
  outputFieldId: string;
  /** Name of the field Framer substitutes for the item's URL slug. */
  slugFieldName: string;
}

const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merge stored values over the defaults one level deep so a config saved before
 * a new field existed still loads, rather than wiping the new field out.
 */
export const mergeSchemaConfig = (
  stored: unknown,
  defaults: SchemaSiteConfig = DEFAULT_SCHEMA_CONFIG
): SchemaSiteConfig => {
  if (!isRecord(stored)) {
    return defaults;
  }
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = value;
  }
  return merged as unknown as SchemaSiteConfig;
};

export const readStoredSchemaConfig = (
  storage: Storage | null = browserStorage()
): SchemaSiteConfig => {
  try {
    const raw = storage?.getItem(SCHEMA_CONFIG_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SCHEMA_CONFIG;
    }
    return mergeSchemaConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_SCHEMA_CONFIG;
  }
};

export const saveSchemaConfig = (
  config: SchemaSiteConfig,
  storage: Storage | null = browserStorage()
): boolean => {
  try {
    if (!storage) {
      return false;
    }
    storage.setItem(SCHEMA_CONFIG_STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
};

export const readStoredCollectionMappings = (
  storage: Storage | null = browserStorage()
): CollectionSchemaMapping[] => {
  try {
    const raw = storage?.getItem(COLLECTION_MAP_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CollectionSchemaMapping[]) : [];
  } catch {
    return [];
  }
};

export const saveCollectionMappings = (
  mappings: readonly CollectionSchemaMapping[],
  storage: Storage | null = browserStorage()
): boolean => {
  try {
    if (!storage) {
      return false;
    }
    storage.setItem(COLLECTION_MAP_STORAGE_KEY, JSON.stringify(mappings));
    return true;
  } catch {
    return false;
  }
};

const FIELD_NAME_HINTS: Readonly<Record<string, readonly string[]>> = {
  body: ["body", "content", "article", "overview", "summary"],
  date: ["date", "published", "publishdate", "posted"],
  description: [
    "description",
    "excerpt",
    "summary",
    "subtitle",
    "seodescription",
  ],
  image: ["image", "thumbnail", "cover", "hero", "ogimage"],
  output: ["schema", "jsonld", "structureddata", "schemajson"],
  title: ["title", "name", "headline", "seotitle"],
};

const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]/gu;

const normalizeFieldName = (name: string): string =>
  name.toLowerCase().replace(NON_ALPHANUMERIC_PATTERN, "");

/**
 * Best-guess field mapping so a freshly-detected collection is usable without
 * hand-picking six dropdowns. Every guess stays editable in the panel.
 */
export const guessFieldId = (
  fields: readonly { id: string; name: string; type: string }[],
  role: keyof typeof FIELD_NAME_HINTS,
  allowedTypes: readonly string[]
): string => {
  const candidates = fields.filter((field) =>
    allowedTypes.includes(field.type)
  );
  const hints = FIELD_NAME_HINTS[role] ?? [];
  for (const hint of hints) {
    const exact = candidates.find(
      (field) => normalizeFieldName(field.name) === hint
    );
    if (exact) {
      return exact.id;
    }
  }
  for (const hint of hints) {
    const partial = candidates.find((field) =>
      normalizeFieldName(field.name).includes(hint)
    );
    if (partial) {
      return partial.id;
    }
  }
  return "";
};

const KIND_BY_PATH_PREFIX: Readonly<Record<string, PageKind>> = {
  "/blog": "blogPost",
  "/case-studies": "caseStudy",
  "/collaborating-with-ai-guides": "guide",
  "/services": "service",
};

export const guessCollectionKind = (
  collectionName: string,
  pathPrefix: string
): PageKind => {
  const byPath = KIND_BY_PATH_PREFIX[pathPrefix];
  if (byPath) {
    return byPath;
  }
  const normalized = collectionName.toLowerCase();
  if (normalized.includes("case")) {
    return "caseStudy";
  }
  if (normalized.includes("blog") || normalized.includes("post")) {
    return "blogPost";
  }
  if (normalized.includes("guide")) {
    return "guide";
  }
  if (normalized.includes("service")) {
    return "service";
  }
  return "generic";
};
