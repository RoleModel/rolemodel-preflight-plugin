import type {
  Collection,
  CreateField,
  Field,
  FieldDataEntry,
  FieldDataInput,
  ManagedCollection,
  ManagedCollectionFieldInput,
  ManagedCollectionItemInput,
} from "@framer/plugin";
import { framer } from "@framer/plugin";

import { fetchManifest, normalizeManifestUrl } from "./manifest";
import type { Manifest, ManifestComponent } from "./manifest";

export const MANIFEST_URL_PLUGIN_DATA_KEY = "rolemodel.manifestUrl";
export const LAST_SYNCED_AT_PLUGIN_DATA_KEY = "rolemodel.lastSyncedAt";
export const LAST_MANIFEST_GENERATED_AT_PLUGIN_DATA_KEY =
  "rolemodel.lastManifestGeneratedAt";
export const CANONICAL_COLLECTION_ID_PLUGIN_DATA_KEY =
  "rolemodel.canonicalManagedCollectionId";
export const CANONICAL_COLLECTION_NAME_PLUGIN_DATA_KEY =
  "rolemodel.canonicalManagedCollectionName";

const FIELD_IDS = {
  category: "cat001",
  componentKey: "cmp001",
  description: "dsc001",
  framerUrl: "url001",
  isCanvas: "cnv001",
  propCount: "prp001",
  propsJson: "prj001",
  propsMetaJson: "pmj001",
  slot: "slt001",
  status: "sts001",
  tags: "tag001",
  title: "ttl001",
} as const;

const STATUS_CASES = [
  { id: "stbl01", name: "Stable" },
  { id: "beta01", name: "Beta" },
  { id: "depr01", name: "Deprecated" },
] as const;

const STATUS_CASE_ID_BY_STATUS = {
  beta: STATUS_CASES[1].id,
  deprecated: STATUS_CASES[2].id,
  stable: STATUS_CASES[0].id,
} as const;

export const managedCollectionFields: ManagedCollectionFieldInput[] = [
  { id: FIELD_IDS.title, name: "Title", type: "string" },
  {
    id: FIELD_IDS.componentKey,
    name: "Component Key",
    type: "string",
  },
  { id: FIELD_IDS.slot, name: "Slot", type: "number" },
  { id: FIELD_IDS.category, name: "Category", type: "string" },
  {
    id: FIELD_IDS.description,
    name: "Description",
    type: "formattedText",
    userEditable: true,
  },
  {
    cases: [...STATUS_CASES],
    id: FIELD_IDS.status,
    name: "Status",
    type: "enum",
  },
  { id: FIELD_IDS.tags, name: "Tags", type: "string" },
  // Framer URL should be a link field for clickable behavior in CMS UI.
  { id: FIELD_IDS.framerUrl, name: "Framer URL", type: "link" },
  { id: FIELD_IDS.propCount, name: "Prop Count", type: "string" },
  { id: FIELD_IDS.propsJson, name: "Props JSON", type: "string" },
  {
    id: FIELD_IDS.propsMetaJson,
    name: "Props Meta JSON",
    type: "string",
  },
  {
    id: FIELD_IDS.isCanvas,
    name: "Canvas Component",
    type: "boolean",
  },
];

export interface SyncResult {
  manifest: Manifest;
  manifestUrl: string;
  removedItemCount: number;
  syncedItemCount: number;
  slotCollisionCount: number;
  slotCollisionCategories: string[];
}

export interface SyncOptions {
  goldenPathKeys?: string[];
  requireUrlsForAllSynced?: boolean;
  strictSlotSync?: boolean;
}

const REGULAR_FIELD_NAMES = {
  category: "Category",
  componentKey: "Component Key",
  description: "Description",
  framerUrl: "Framer URL",
  isCanvas: "Canvas Component",
  propCount: "Prop Count",
  propsJson: "Props JSON",
  propsMetaJson: "Props Meta JSON",
  slot: "Slot",
  status: "Status",
  tags: "Tags",
  title: "Title",
} as const;

const EXPECTED_REGULAR_FIELD_TYPES: Record<
  keyof typeof REGULAR_FIELD_NAMES,
  readonly string[]
> = {
  category: ["string"],
  componentKey: ["string"],
  description: ["formattedText", "string"],
  framerUrl: ["string", "link"],
  isCanvas: ["boolean"],
  propCount: ["string"],
  propsJson: ["string"],
  propsMetaJson: ["string"],
  slot: ["number", "string"],
  status: ["string"],
  tags: ["string", "multiCollectionReference"],
  title: ["string"],
} as const;

const latestUrl = (component: ManifestComponent): string =>
  component.framerUrl ?? "";

const normalizeFramerCdnUrl = (url: unknown): string | null => {
  if (typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("https://framer.com/m/")) {
    return null;
  }
  // Never write unresolved/local placeholder specifiers into CMS URL fields.
  if (
    trimmed.includes("!missing/") ||
    trimmed.includes("#framer/local/") ||
    trimmed.includes("localhost:")
  ) {
    return null;
  }
  return trimmed;
};

const loadManifestForSync = (manifestUrl: string): Promise<Manifest> =>
  // Strict pipeline:
  // regenerate -> public/component-manifest.json -> CMS sync
  // Do not hydrate/augment URL values from any other source during sync.
  fetchManifest(manifestUrl);

const propsJson = (component: ManifestComponent): string =>
  JSON.stringify(
    (component.propDocs ?? []).map(({ name, type, description, required }) => ({
      description,
      name,
      required,
      type,
    }))
  );

const propsMetaJson = (component: ManifestComponent): string =>
  JSON.stringify(component.propDocs ?? []);

const assertManifestHasUsableUrls = (
  manifest: Manifest,
  manifestUrl: string
): void => {
  const components = Object.values(manifest.components ?? {});
  if (components.length === 0) {
    return;
  }

  const withUrl = components.filter((component) => {
    const value = latestUrl(component);
    return typeof value === "string" && value.trim().length > 0;
  }).length;

  if (withUrl === 0) {
    throw new Error(
      [
        "Manifest has 0 component URLs, so CMS sync would write blank 'Framer URL' values.",
        `Manifest URL: ${manifestUrl}`,
        "Run Discover Project URLs, regenerate artifacts, and verify the plugin points to the updated component-manifest.json.",
      ].join(" ")
    );
  }
};

const applyManifestSyncScope = (
  manifest: Manifest,
  options?: SyncOptions
): Manifest => {
  const scopedKeys = [
    ...new Set(
      (options?.goldenPathKeys ?? [])
        .map((key) => String(key ?? "").trim())
        .filter(Boolean)
    ),
  ];

  if (scopedKeys.length === 0) {
    return manifest;
  }

  const byLowerKey = new Map(
    Object.values(manifest.components ?? {}).map((component) => [
      component.key.trim().toLowerCase(),
      component,
    ])
  );

  const missingKeys: string[] = [];
  const scopedComponents: Record<string, ManifestComponent> = {};

  for (const key of scopedKeys) {
    const found = byLowerKey.get(key.toLowerCase());
    if (!found) {
      missingKeys.push(key);
      continue;
    }
    scopedComponents[found.key] = found;
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Golden path sync aborted. Missing component keys in manifest: ${missingKeys.join(", ")}.`
    );
  }

  if (options?.requireUrlsForAllSynced) {
    const keysMissingUrls = Object.values(scopedComponents)
      .filter((component) => !normalizeFramerCdnUrl(component.framerUrl))
      .map((component) => component.key);
    if (keysMissingUrls.length > 0) {
      throw new Error(
        `Golden path sync aborted. Components missing valid Framer URL: ${keysMissingUrls.join(", ")}.`
      );
    }
  }

  return {
    ...manifest,
    categories: [
      ...new Set(
        Object.values(scopedComponents).map((component) => component.category)
      ),
    ].toSorted(),
    components: scopedComponents,
    totalComponents: Object.keys(scopedComponents).length,
  };
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);

const ensureUniqueSlug = (
  base: string,
  usedSlugs: Set<string>,
  fallbackSeed: string
): string => {
  const normalizedBase = slugify(base) || slugify(fallbackSeed) || "component";
  if (!usedSlugs.has(normalizedBase)) {
    usedSlugs.add(normalizedBase);
    return normalizedBase;
  }

  let counter = 2;
  while (counter < 10_000) {
    const suffix = `-${counter}`;
    const maxBaseLength = Math.max(1, 64 - suffix.length);
    const candidate = `${normalizedBase.slice(0, maxBaseLength)}${suffix}`;
    if (!usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
    counter += 1;
  }

  // Should never happen, but return a deterministic fallback if it does.
  const fallback = `${normalizedBase.slice(0, 58)}-${Date.now().toString().slice(-5)}`;
  usedSlugs.add(fallback);
  return fallback;
};

const stringEntry = (value: unknown) => ({
  type: "string" as const,
  value: typeof value === "string" ? value : String(value ?? ""),
});

const linkEntry = (value: unknown) => ({
  type: "link" as const,
  value: typeof value === "string" ? value : String(value ?? ""),
});

const booleanEntry = (value: unknown) => ({
  type: "boolean" as const,
  value: Boolean(value),
});

const numberEntry = (value: unknown) => ({
  type: "number" as const,
  value: Number(value) || 0,
});

const enumEntry = (value: string) => ({
  type: "enum" as const,
  value,
});

const formattedTextEntry = (value: unknown) => ({
  contentType: "markdown" as const,
  type: "formattedText" as const,
  value: typeof value === "string" ? value : String(value ?? ""),
});

const componentToCollectionItem = (
  component: ManifestComponent,
  slot: number
): ManagedCollectionItemInput => {
  const fieldData: FieldDataInput = {
    [FIELD_IDS.title]: stringEntry(component.displayName),
    [FIELD_IDS.componentKey]: stringEntry(component.key),
    [FIELD_IDS.slot]: numberEntry(slot),
    [FIELD_IDS.category]: stringEntry(component.category),
    [FIELD_IDS.description]: formattedTextEntry(component.description),
    [FIELD_IDS.status]: enumEntry(STATUS_CASE_ID_BY_STATUS[component.status]),
    [FIELD_IDS.tags]: stringEntry(component.tags.join(", ")),
    [FIELD_IDS.framerUrl]: linkEntry(latestUrl(component)),
    [FIELD_IDS.propCount]: stringEntry(component.propCount),
    [FIELD_IDS.propsJson]: stringEntry(propsJson(component)),
    [FIELD_IDS.propsMetaJson]: stringEntry(propsMetaJson(component)),
    [FIELD_IDS.isCanvas]: booleanEntry(component.isCanvas),
  };

  return {
    fieldData,
    id: component.key,
    slug: slugify(component.key),
  };
};

const normalizeCategory = (value: string | undefined): string => {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : "Uncategorized";
};

interface SlotAssignmentPlan {
  slotByKey: Map<string, number>;
  slotCollisionCount: number;
  slotCollisionCategories: string[];
}

const buildCategorySlotPlan = (
  components: ManifestComponent[],
  options?: { strictSlotSync?: boolean }
): SlotAssignmentPlan => {
  const strict = options?.strictSlotSync === true;
  const grouped = new Map<string, ManifestComponent[]>();
  for (const component of components) {
    const category = normalizeCategory(component.category);
    const list = grouped.get(category) ?? [];
    list.push(component);
    grouped.set(category, list);
  }

  const slotByKey = new Map<string, number>();
  let slotCollisionCount = 0;
  const slotCollisionCategories = new Set<string>();
  for (const [category, list] of [...grouped.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    void category;
    const sorted = [...list].toSorted((left, right) =>
      left.displayName.localeCompare(right.displayName)
    );
    if (strict && sorted.length > 30) {
      slotCollisionCount += sorted.length - 30;
      slotCollisionCategories.add(category);
    }
    for (const [index, component] of sorted.entries()) {
      slotByKey.set(component.key, (index % 30) + 1);
    }
  }

  return {
    slotByKey,
    slotCollisionCategories: [...slotCollisionCategories].toSorted((a, b) =>
      a.localeCompare(b)
    ),
    slotCollisionCount,
  };
};

const componentToRegularFieldData = (
  component: ManifestComponent,
  slot: number,
  fieldIds: Record<string, string>,
  fieldTypes: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>
): FieldDataInput => {
  const descriptionEntry =
    fieldTypes.description === "formattedText"
      ? formattedTextEntry(component.description)
      : stringEntry(component.description);
  const framerUrlEntry =
    fieldTypes.framerUrl === "link"
      ? linkEntry(latestUrl(component))
      : stringEntry(latestUrl(component));

  const fieldData: FieldDataInput = {
    [fieldIds.title]: stringEntry(component.displayName),
    [fieldIds.componentKey]: stringEntry(component.key),
    [fieldIds.slot]:
      fieldTypes.slot === "number" ? numberEntry(slot) : stringEntry(slot),
    [fieldIds.category]: stringEntry(component.category),
    [fieldIds.description]: descriptionEntry,
    [fieldIds.status]: stringEntry(component.status),
    [fieldIds.framerUrl]: framerUrlEntry,
    [fieldIds.propCount]: stringEntry(component.propCount),
    [fieldIds.propsJson]: stringEntry(propsJson(component)),
    [fieldIds.propsMetaJson]: stringEntry(propsMetaJson(component)),
    [fieldIds.isCanvas]: booleanEntry(component.isCanvas),
  };

  // Some teams model tags as multi-collection references in Framer CMS.
  // We do not have deterministic reference IDs here, so keep sync non-blocking
  // by skipping tag writes for that shape instead of failing the whole sync.
  if (fieldTypes.tags === "string") {
    fieldData[fieldIds.tags] = stringEntry(component.tags.join(", "));
  }

  return fieldData;
};

const extractStringFieldValue = (entry: FieldDataEntry | undefined): string => {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if ("value" in entry) {
    const { value } = entry as { value?: unknown };
    if (typeof value === "string") {
      return value;
    }
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  }
  return "";
};

const readFramerUrlFromFieldEntry = (
  entry: FieldDataEntry | undefined
): string => {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if ("value" in entry) {
    const { value } = entry as { value?: unknown };
    if (typeof value === "string") {
      return normalizeFramerCdnUrl(value.trim()) ?? "";
    }
    if (value && typeof value === "object") {
      const maybeUrl = (value as { url?: unknown }).url;
      if (typeof maybeUrl === "string") {
        return normalizeFramerCdnUrl(maybeUrl.trim()) ?? "";
      }
    }
  }

  const raw = extractStringFieldValue(entry).trim();
  return normalizeFramerCdnUrl(raw) ?? "";
};

const readEntryRawValue = (entry: FieldDataEntry | undefined): unknown =>
  entry && typeof entry === "object" && "value" in entry
    ? (entry as { value?: unknown }).value
    : undefined;

const normalizeMultiCollectionReferenceEntry = (
  entry: FieldDataEntry | undefined
) => {
  const rawValue = readEntryRawValue(entry);
  const values = Array.isArray(rawValue)
    ? rawValue.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  return {
    type: "multiCollectionReference" as const,
    value: values,
  };
};

const normalizeFieldEntryForType = (
  fieldType: string,
  entry: FieldDataEntry | undefined
) => {
  switch (fieldType) {
    case "multiCollectionReference": {
      return normalizeMultiCollectionReferenceEntry(entry);
    }
    case "boolean": {
      return booleanEntry(readEntryRawValue(entry));
    }
    case "number": {
      return numberEntry(readEntryRawValue(entry));
    }
    case "formattedText": {
      const rawValue = readEntryRawValue(entry);
      return formattedTextEntry(
        typeof rawValue === "string" ? rawValue : extractStringFieldValue(entry)
      );
    }
    case "link": {
      return linkEntry(readFramerUrlFromFieldEntry(entry));
    }
    default: {
      return stringEntry(extractStringFieldValue(entry));
    }
  }
};

const normalizeRegularFieldDataForCollection = (
  fieldData: FieldDataInput,
  fieldIds: Record<keyof typeof REGULAR_FIELD_NAMES, string>,
  fieldTypes: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>
): FieldDataInput => {
  const normalized: FieldDataInput = { ...fieldData };
  const keys = Object.keys(
    REGULAR_FIELD_NAMES
  ) as (keyof typeof REGULAR_FIELD_NAMES)[];

  for (const key of keys) {
    const fieldId = fieldIds[key];
    const fieldType = fieldTypes[key] ?? "string";
    const entry = normalized[fieldId] as FieldDataEntry | undefined;
    normalized[fieldId] = normalizeFieldEntryForType(fieldType, entry);
  }

  return normalized;
};

const fieldNameToKey = (
  name: string
): keyof typeof REGULAR_FIELD_NAMES | null => {
  const cleaned = String(name ?? "")
    .trim()
    .toLowerCase();
  for (const [key, value] of Object.entries(REGULAR_FIELD_NAMES) as [
    keyof typeof REGULAR_FIELD_NAMES,
    string,
  ][]) {
    if (value.toLowerCase() === cleaned) {
      return key;
    }
  }
  return null;
};

const isPrimaryFieldName = (
  key: keyof typeof REGULAR_FIELD_NAMES,
  name: string
): boolean =>
  String(name ?? "")
    .trim()
    .toLowerCase() === REGULAR_FIELD_NAMES[key].toLowerCase();

const pickPreferredField = (
  current: Field | undefined,
  candidate: Field,
  key: keyof typeof REGULAR_FIELD_NAMES
): Field => {
  if (!current) {
    return candidate;
  }
  const currentIsPrimary = isPrimaryFieldName(key, current.name);
  const candidateIsPrimary = isPrimaryFieldName(key, candidate.name);
  if (candidateIsPrimary && !currentIsPrimary) {
    return candidate;
  }
  return current;
};

const normalizeTagValue = (value: string): string => value.trim().toLowerCase();

const tagLookupKeys = (value: string): string[] => {
  const normalized = normalizeTagValue(value);
  const slug = slugify(value);
  return [...new Set([normalized, slug])];
};

const createTagReferenceResolver = async (collectionId: string) => {
  const tagCollection = await framer.getCollection(collectionId);
  if (!tagCollection) {
    throw new Error(
      `Unable to resolve referenced tags collection (${collectionId})`
    );
  }

  const tagFields = await tagCollection.getFields();
  const labelField =
    tagFields.find((field) => {
      if (String(field.type) !== "string") {
        return false;
      }
      const name = String(field.name ?? "")
        .trim()
        .toLowerCase();
      return name === "title" || name === "name" || name === "tag";
    }) ?? tagFields.find((field) => String(field.type) === "string");

  const keyToId = new Map<string, string>();
  const usedSlugs = new Set<string>();

  const indexItem = (item: {
    id: string;
    slug: string;
    fieldData: FieldDataInput | Record<string, FieldDataEntry>;
  }) => {
    const itemSlug = String(item.slug || "").trim();
    if (itemSlug) {
      usedSlugs.add(itemSlug.toLowerCase());
      for (const key of tagLookupKeys(itemSlug)) {
        keyToId.set(key, item.id);
      }
    }
    if (labelField) {
      const label = extractStringFieldValue(
        (item.fieldData as Record<string, FieldDataEntry>)[labelField.id]
      );
      if (label.trim().length > 0) {
        for (const key of tagLookupKeys(label)) {
          keyToId.set(key, item.id);
        }
      }
    }
  };

  const refreshIndex = async () => {
    keyToId.clear();
    usedSlugs.clear();
    const items = await tagCollection.getItems();
    for (const item of items) {
      indexItem(item);
    }
  };

  await refreshIndex();

  return async (tags: string[]): Promise<string[]> => {
    const wanted = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    const missing: string[] = [];
    const ids: string[] = [];

    for (const tag of wanted) {
      const existingId = tagLookupKeys(tag)
        .map((key) => keyToId.get(key))
        .find(Boolean);
      if (existingId) {
        ids.push(existingId);
      } else {
        missing.push(tag);
      }
    }

    if (missing.length > 0) {
      const toAdd = missing.map((tag) => {
        const baseSlug = slugify(tag) || "tag";
        let nextSlug = baseSlug;
        let n = 2;
        while (usedSlugs.has(nextSlug.toLowerCase())) {
          nextSlug = `${baseSlug}-${n}`;
          n += 1;
        }
        usedSlugs.add(nextSlug.toLowerCase());

        return {
          slug: nextSlug,
          ...(labelField
            ? {
                fieldData: {
                  [labelField.id]: stringEntry(tag),
                } satisfies FieldDataInput,
              }
            : {}),
        };
      });
      try {
        await tagCollection.addItems(toAdd);
        await refreshIndex();
      } catch (error) {
        console.warn(
          `[CMS Sync] Unable to create missing tag references in collection ${collectionId}:`,
          error
        );
      }

      for (const tag of missing) {
        const createdId = tagLookupKeys(tag)
          .map((key) => keyToId.get(key))
          .find(Boolean);
        if (createdId) {
          ids.push(createdId);
        }
      }
    }

    return [...new Set(ids)];
  };
};

interface IncompatiblePrimaryField {
  name: string;
  foundType: string;
  expectedType: string;
}

const classifyExistingFields = (
  existingFields: Field[]
): {
  byKey: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, Field>>;
  incompatiblePrimaryFields: IncompatiblePrimaryField[];
} => {
  const byKey: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, Field>> = {};
  const incompatiblePrimaryFields: IncompatiblePrimaryField[] = [];

  for (const field of existingFields) {
    const key = fieldNameToKey(field.name);
    if (!key) {
      continue;
    }
    const expectedTypes = EXPECTED_REGULAR_FIELD_TYPES[key];
    if (!expectedTypes.includes(String(field.type))) {
      const normalizedName = String(field.name ?? "")
        .trim()
        .toLowerCase();
      const primaryName = REGULAR_FIELD_NAMES[key].toLowerCase();
      if (normalizedName === primaryName) {
        incompatiblePrimaryFields.push({
          expectedType: expectedTypes.join(" | "),
          foundType: String(field.type),
          name: String(field.name ?? ""),
        });
      }
      continue;
    }
    byKey[key] = pickPreferredField(byKey[key], field, key);
  }

  return { byKey, incompatiblePrimaryFields };
};

const assertNoIncompatiblePrimaryFields = (
  incompatiblePrimaryFields: IncompatiblePrimaryField[]
): void => {
  if (incompatiblePrimaryFields.length === 0) {
    return;
  }
  const detail = incompatiblePrimaryFields
    .map(
      (field) =>
        `${field.name} (found ${field.foundType}, expected ${field.expectedType})`
    )
    .join(", ");
  throw new Error(
    `Collection has incompatible field types for required RoleModel fields: ${detail}. Rename or delete these fields (or create a fresh collection) and sync again.`
  );
};

const buildMissingFieldDefinitions = (
  byKey: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, Field>>
): CreateField[] => {
  const missing: CreateField[] = [];
  const addString = (key: keyof typeof REGULAR_FIELD_NAMES) =>
    missing.push({ name: REGULAR_FIELD_NAMES[key], type: "string" });

  if (!byKey.title) {
    addString("title");
  }
  if (!byKey.componentKey) {
    addString("componentKey");
  }
  if (!byKey.slot) {
    missing.push({ name: REGULAR_FIELD_NAMES.slot, type: "number" });
  }
  if (!byKey.category) {
    addString("category");
  }
  if (!byKey.description) {
    missing.push({
      name: REGULAR_FIELD_NAMES.description,
      type: "formattedText",
    });
  }
  if (!byKey.status) {
    addString("status");
  }
  if (!byKey.tags) {
    addString("tags");
  }
  if (!byKey.framerUrl) {
    missing.push({
      name: REGULAR_FIELD_NAMES.framerUrl,
      type: "link",
    });
  }
  if (!byKey.propCount) {
    addString("propCount");
  }
  if (!byKey.propsJson) {
    addString("propsJson");
  }
  if (!byKey.propsMetaJson) {
    addString("propsMetaJson");
  }
  if (!byKey.isCanvas) {
    missing.push({ name: REGULAR_FIELD_NAMES.isCanvas, type: "boolean" });
  }

  return missing;
};

const selectPreferredFieldsByKey = (
  fields: Field[]
): Partial<Record<keyof typeof REGULAR_FIELD_NAMES, Field>> => {
  const selectedFields: Partial<
    Record<keyof typeof REGULAR_FIELD_NAMES, Field>
  > = {};
  for (const field of fields) {
    const key = fieldNameToKey(field.name);
    if (!key) {
      continue;
    }
    if (!EXPECTED_REGULAR_FIELD_TYPES[key].includes(String(field.type))) {
      continue;
    }
    selectedFields[key] = pickPreferredField(selectedFields[key], field, key);
  }
  return selectedFields;
};

const buildFieldIdsAndTypes = (
  selectedFields: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, Field>>
): {
  fieldIds: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>;
  fieldTypes: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>;
} => {
  const fieldIds: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>> =
    {};
  const fieldTypes: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>> =
    {};

  for (const [key, field] of Object.entries(selectedFields) as [
    keyof typeof REGULAR_FIELD_NAMES,
    Field,
  ][]) {
    fieldIds[key] = field.id;
    fieldTypes[key] = String(field.type);
  }

  return { fieldIds, fieldTypes };
};

const assertAllRequiredFieldsPresent = (
  fieldIds: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>
): void => {
  const requiredKeys = Object.keys(
    REGULAR_FIELD_NAMES
  ) as (keyof typeof REGULAR_FIELD_NAMES)[];
  for (const key of requiredKeys) {
    if (!fieldIds[key]) {
      const expected = EXPECTED_REGULAR_FIELD_TYPES[key].join(" | ");
      throw new Error(
        `Missing required CMS field: ${REGULAR_FIELD_NAMES[key]} (${expected})`
      );
    }
  }
};

const ensureRegularCollectionFields = async (
  collection: Collection
): Promise<{
  fieldIds: Record<keyof typeof REGULAR_FIELD_NAMES, string>;
  fieldTypes: Partial<Record<keyof typeof REGULAR_FIELD_NAMES, string>>;
}> => {
  const existingFields = await collection.getFields();
  const { byKey, incompatiblePrimaryFields } =
    classifyExistingFields(existingFields);
  assertNoIncompatiblePrimaryFields(incompatiblePrimaryFields);

  const missing = buildMissingFieldDefinitions(byKey);
  if (missing.length > 0) {
    await collection.addFields(missing);
  }

  const refreshedFields = await collection.getFields();
  const selectedFields = selectPreferredFieldsByKey(refreshedFields);
  const { fieldIds, fieldTypes } = buildFieldIdsAndTypes(selectedFields);
  assertAllRequiredFieldsPresent(fieldIds);

  return {
    fieldIds: fieldIds as Record<keyof typeof REGULAR_FIELD_NAMES, string>,
    fieldTypes,
  };
};

export const syncManagedCollectionFromManifest = async (
  collection: ManagedCollection,
  manifestUrlInput: string,
  options?: SyncOptions
): Promise<SyncResult> => {
  const manifestUrl = normalizeManifestUrl(manifestUrlInput);
  const manifest = applyManifestSyncScope(
    await loadManifestForSync(manifestUrl),
    options
  );
  assertManifestHasUsableUrls(manifest, manifestUrl);
  const components = Object.values(manifest.components).toSorted(
    (left, right) => left.displayName.localeCompare(right.displayName)
  );
  const slotPlan = buildCategorySlotPlan(components, {
    strictSlotSync: options?.strictSlotSync,
  });
  const { slotByKey } = slotPlan;
  const items = components.map((component) =>
    componentToCollectionItem(component, slotByKey.get(component.key) ?? 1)
  );

  await collection.setFields([...managedCollectionFields]);

  const existingIds = new Set(await collection.getItemIds());
  await collection.addItems(items);

  const incomingIds = new Set(items.map((item) => item.id));
  const staleIds = [...existingIds].filter((id) => !incomingIds.has(id));
  if (staleIds.length > 0) {
    await collection.removeItems(staleIds);
  }

  await collection.setItemOrder(items.map((item) => item.id));

  return {
    manifest,
    manifestUrl,
    removedItemCount: staleIds.length,
    slotCollisionCategories: slotPlan.slotCollisionCategories,
    slotCollisionCount: slotPlan.slotCollisionCount,
    syncedItemCount: items.length,
  };
};

export const syncRegularCollectionFromManifest = async (
  collection: Collection,
  manifestUrlInput: string,
  options?: SyncOptions
): Promise<SyncResult> => {
  const manifestUrl = normalizeManifestUrl(manifestUrlInput);
  const manifest = applyManifestSyncScope(
    await loadManifestForSync(manifestUrl),
    options
  );
  assertManifestHasUsableUrls(manifest, manifestUrl);
  const components = Object.values(manifest.components).toSorted(
    (left, right) => left.displayName.localeCompare(right.displayName)
  );
  const slotPlan = buildCategorySlotPlan(components, {
    strictSlotSync: options?.strictSlotSync,
  });
  const { slotByKey } = slotPlan;

  const { fieldIds, fieldTypes } =
    await ensureRegularCollectionFields(collection);
  const fields = await collection.getFields();
  const tagsField = fields.find((field) => field.id === fieldIds.tags);
  const tagsReferenceCollectionId =
    fieldTypes.tags === "multiCollectionReference" &&
    tagsField &&
    "collectionId" in tagsField
      ? String((tagsField as { collectionId: string }).collectionId)
      : null;
  const resolveTagReferences =
    tagsReferenceCollectionId === null
      ? null
      : await createTagReferenceResolver(tagsReferenceCollectionId).catch(
          (error) => {
            console.warn(
              `[CMS Sync] Failed to initialize multiCollectionReference resolver for tags (${tagsReferenceCollectionId}). Sync will continue without updating tag references.`,
              error
            );
            return null;
          }
        );
  const existingItems = await collection.getItems();
  const existingByComponentKey = new Map<
    string,
    { id: string; slug: string; framerUrl: string }
  >();
  const usedSlugs = new Set<string>();
  const duplicateIds: string[] = [];
  const keylessIds: string[] = [];

  for (const item of existingItems) {
    if (item.slug) {
      usedSlugs.add(String(item.slug).trim().toLowerCase());
    }
    const componentKeyFieldId = fieldIds.componentKey;
    const componentKey = extractStringFieldValue(
      item.fieldData[componentKeyFieldId]
    ).trim();
    const normalizedComponentKey = componentKey.toLowerCase();
    if (!normalizedComponentKey) {
      keylessIds.push(item.id);
      continue;
    }

    if (existingByComponentKey.has(normalizedComponentKey)) {
      duplicateIds.push(item.id);
      continue;
    }

    existingByComponentKey.set(normalizedComponentKey, {
      framerUrl: readFramerUrlFromFieldEntry(
        item.fieldData[fieldIds.framerUrl]
      ),
      id: item.id,
      slug: String(item.slug || "").trim(),
    });
  }

  const addOrUpdateItems = await Promise.all(
    components.map(async (component) => {
      const slot = slotByKey.get(component.key) ?? 1;
      const existingItem = existingByComponentKey.get(
        component.key.trim().toLowerCase()
      );
      const slug =
        existingItem?.slug ||
        ensureUniqueSlug(
          component.key || component.displayName || "component",
          usedSlugs,
          component.displayName || component.key || "component"
        );
      const fieldData = componentToRegularFieldData(
        component,
        slot,
        fieldIds,
        fieldTypes
      );
      const nextFramerUrl = readFramerUrlFromFieldEntry(
        fieldData[fieldIds.framerUrl]
      );
      // Safety guard: never clear a previously known URL in CMS when the
      // computed sync payload has no valid URL for this component.
      if (!nextFramerUrl && existingItem?.framerUrl) {
        fieldData[fieldIds.framerUrl] =
          fieldTypes.framerUrl === "link"
            ? linkEntry(existingItem.framerUrl)
            : stringEntry(existingItem.framerUrl);
      }
      if (
        fieldTypes.tags === "multiCollectionReference" &&
        resolveTagReferences
      ) {
        fieldData[fieldIds.tags] = {
          type: "multiCollectionReference" as const,
          value: await resolveTagReferences(component.tags),
        };
      }
      return {
        ...(existingItem ? { id: existingItem.id } : {}),
        fieldData: normalizeRegularFieldDataForCollection(
          fieldData,
          fieldIds,
          fieldTypes
        ),
        slug,
      };
    })
  );

  if (addOrUpdateItems.length > 0) {
    await collection.addItems(addOrUpdateItems);
  }

  const incomingKeys = new Set(
    components.map((component) => component.key.trim().toLowerCase())
  );
  const staleIds = [...existingByComponentKey.entries()]
    .filter(([componentKey]) => !incomingKeys.has(componentKey))
    .map(([, item]) => item.id);
  const idsToRemove = [
    ...new Set([...staleIds, ...duplicateIds, ...keylessIds]),
  ];

  if (idsToRemove.length > 0) {
    await collection.removeItems(idsToRemove);
  }

  return {
    manifest,
    manifestUrl,
    removedItemCount: idsToRemove.length,
    slotCollisionCategories: slotPlan.slotCollisionCategories,
    slotCollisionCount: slotPlan.slotCollisionCount,
    syncedItemCount: components.length,
  };
};
