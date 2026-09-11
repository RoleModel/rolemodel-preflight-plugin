import type { CollectionItem } from "@framer/plugin";

import type { PageContent } from "./schema";
import type { CollectionSchemaMapping } from "./schema-config";

const HTML_TAG_PATTERN = /<[^>]*>/gu;
const HTML_ENTITY_PATTERN = /&(?<entity>amp|lt|gt|quot|#39|nbsp);/gu;
const WHITESPACE_RUN_PATTERN = /\s+/gu;
const TRAILING_SLASH_PATTERN = /\/+$/u;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "#39": "'",
  amp: "&",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** Framer rich text arrives as HTML; structured data wants plain prose. */
export const htmlToPlainText = (html: string): string =>
  html
    .replace(HTML_TAG_PATTERN, " ")
    .replace(HTML_ENTITY_PATTERN, (...args: unknown[]) => {
      const groups = args.at(-1) as { entity?: string } | undefined;
      return HTML_ENTITIES[groups?.entity ?? ""] ?? " ";
    })
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim();

type FieldReader = (fieldId: string) => unknown;

const readField = (item: CollectionItem, fieldId: string): unknown => {
  if (!fieldId) {
    return;
  }
  return item.fieldData[fieldId];
};

export const stringFieldValue = (
  item: CollectionItem,
  fieldId: string,
  read: FieldReader = (id) => readField(item, id)
): string => {
  const entry = read(fieldId);
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const record = entry as { type?: string; value?: unknown };
  if (record.type === "string" && typeof record.value === "string") {
    return record.value.trim();
  }
  if (
    (record.type === "formattedText" || record.type === "richText") &&
    typeof record.value === "string"
  ) {
    return htmlToPlainText(record.value);
  }
  if (record.type === "date" && typeof record.value === "string") {
    return record.value.trim();
  }
  return "";
};

export const imageFieldUrl = (
  item: CollectionItem,
  fieldId: string,
  read: FieldReader = (id) => readField(item, id)
): string => {
  const entry = read(fieldId);
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const record = entry as { type?: string; value?: { url?: string } };
  if (record.type === "image" && typeof record.value?.url === "string") {
    return record.value.url;
  }
  return "";
};

/**
 * Framer stores a collection page's path as a template (`/blog/:slug`). The
 * published URL is that prefix plus the item's slug, so build it from the
 * mapping's prefix rather than the template.
 */
export const itemPath = (pathPrefix: string, slug: string): string => {
  const prefix = pathPrefix.replace(TRAILING_SLASH_PATTERN, "");
  return `${prefix}/${slug}`;
};

export interface CmsPageContentOptions {
  mapping: CollectionSchemaMapping;
  item: CollectionItem;
  /** Injection point so tests can supply plain objects instead of live items. */
  read?: FieldReader;
}

export const buildPageContentFromCmsItem = ({
  item,
  mapping,
  read,
}: CmsPageContentOptions): PageContent => {
  const reader: FieldReader = read ?? ((id) => readField(item, id));
  const title = stringFieldValue(item, mapping.titleFieldId, reader);
  const body = stringFieldValue(item, mapping.bodyFieldId, reader);
  const description = stringFieldValue(
    item,
    mapping.descriptionFieldId,
    reader
  );
  const datePublished = stringFieldValue(
    item,
    mapping.datePublishedFieldId,
    reader
  );

  return {
    bodyText: body || undefined,
    collectionName: mapping.collectionName,
    datePublished: datePublished || undefined,
    description: description || undefined,
    imageUrl: imageFieldUrl(item, mapping.imageFieldId, reader) || undefined,
    path: itemPath(mapping.pathPrefix, item.slug),
    source: "cms",
    title: title || item.slug,
  };
};

export interface CmsMappingReadiness {
  ready: boolean;
  missing: string[];
  /** Roles the output field collides with. Non-empty means writing destroys content. */
  conflicts: string[];
}

const READ_ROLE_LABELS: Readonly<
  Record<keyof CollectionSchemaMapping & string, string>
> = {
  bodyFieldId: "body",
  datePublishedFieldId: "date",
  descriptionFieldId: "description",
  imageFieldId: "image",
  titleFieldId: "title",
} as unknown as Readonly<Record<string, string>>;

/**
 * The output field is overwritten wholesale. If it is also a field we read
 * from — title, description, body, date, image — writing destroys real content.
 * This has happened; it must be impossible, not merely discouraged.
 */
export const findOutputFieldConflicts = (
  mapping: CollectionSchemaMapping
): string[] => {
  if (!mapping.outputFieldId) {
    return [];
  }
  const conflicts: string[] = [];
  for (const [key, label] of Object.entries(READ_ROLE_LABELS)) {
    const value = (mapping as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && value && value === mapping.outputFieldId) {
      conflicts.push(label);
    }
  }
  return conflicts;
};

/** What still has to be picked before a collection can be generated. */
export const checkMappingReadiness = (
  mapping: CollectionSchemaMapping
): CmsMappingReadiness => {
  const missing: string[] = [];
  if (!mapping.pathPrefix.trim()) {
    missing.push("path prefix");
  }
  if (!mapping.titleFieldId) {
    missing.push("title field");
  }
  if (!mapping.outputFieldId) {
    missing.push("schema output field");
  }
  const conflicts = findOutputFieldConflicts(mapping);
  return {
    conflicts,
    missing,
    ready: missing.length === 0 && conflicts.length === 0,
  };
};
