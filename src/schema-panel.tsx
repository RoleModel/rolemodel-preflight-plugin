import { framer, useIsAllowedTo } from "@framer/plugin";
import React, { useCallback, useMemo, useState } from "react";

import {
  buildCmsFieldValue,
  buildCmsTemplateSnippet,
  buildCombinedSiteCustomCode,
  buildPageGraph,
  classifyPath,
  estimateSnippetKb,
  serializeGraph,
  titleFromSlug,
  validateGraph,
} from "./lib/schema";
import type {
  PageContent,
  PathGraphEntry,
  SchemaIssue,
  SchemaSiteConfig,
} from "./lib/schema";
import {
  buildPageContentFromCmsItem,
  checkMappingReadiness,
} from "./lib/schema-cms";
import {
  DEFAULT_SCHEMA_CONFIG,
  guessCollectionKind,
  guessFieldId,
  readStoredCollectionMappings,
  readStoredSchemaConfig,
  saveCollectionMappings,
  saveSchemaConfig,
} from "./lib/schema-config";
import type { CollectionSchemaMapping } from "./lib/schema-config";

interface FieldOption {
  id: string;
  name: string;
  type: string;
}

interface CollectionRow {
  mapping: CollectionSchemaMapping;
  fields: FieldOption[];
  itemCount: number;
}

interface StaticPageRow {
  path: string;
  title: string;
  graph: PathGraphEntry["graph"];
  issues: SchemaIssue[];
}

interface CmsPreviewRow {
  itemId: string;
  path: string;
  value: string;
  issues: SchemaIssue[];
}

/** Written to — must be a real plain text field. */
const OUTPUT_FIELD_TYPES = ["string"] as const;
/** Read from — rich text is fine, it gets converted to prose. */
const TEXT_FIELD_TYPES = ["string", "formattedText", "richText"] as const;
const BODY_FIELD_TYPES = ["formattedText", "richText", "string"] as const;
const IMAGE_FIELD_TYPES = ["image"] as const;
const DATE_FIELD_TYPES = ["date", "string"] as const;
const PREVIEW_LIMIT = 3;
const COPY_RESET_MS = 2000;
const FAILURE_DETAIL_LIMIT = 3;

const SLUGIFY_PATTERN = /[^a-z0-9]/gu;

const slugify = (value: string): string =>
  value.toLowerCase().replace(SLUGIFY_PATTERN, "");

/**
 * Pick the templated path whose prefix reads like the collection's name
 * ("Case Studies" -> "/case-studies"). Returns "" when nothing matches
 * confidently, so the panel asks rather than mislabels every item's URL.
 */
const matchTemplatePrefix = (
  collectionName: string,
  prefixes: readonly string[]
): string => {
  const target = slugify(collectionName);
  if (!target) {
    return "";
  }
  const matches = prefixes.filter((prefix) => {
    const candidate = slugify(prefix);
    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
  return matches.length === 1 ? (matches[0] ?? "") : "";
};

/** Framer stores collection page paths as templates: /blog/:slug. */
const prefixFromTemplate = (template: string): string =>
  template.split("/:")[0] ?? "";

const fieldsOfType = (
  fields: readonly FieldOption[],
  allowed: readonly string[]
): FieldOption[] => fields.filter((field) => allowed.includes(field.type));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const SchemaPanel = () => {
  const canSetCustomCode = useIsAllowedTo("setCustomCode");
  const canUpdateItems = useIsAllowedTo("CollectionItem.setAttributes");

  const [config, setConfig] = useState<SchemaSiteConfig>(
    readStoredSchemaConfig
  );
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [staticPages, setStaticPages] = useState<StaticPageRow[]>([]);
  const [cmsPreview, setCmsPreview] = useState<CmsPreviewRow[]>([]);
  const [cmsEntries, setCmsEntries] = useState<PathGraphEntry[]>([]);
  const [showCmsWrite, setShowCmsWrite] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const siteCustomCode = useMemo(
    () =>
      buildCombinedSiteCustomCode(config, [
        ...staticPages.map((page) => ({ graph: page.graph, path: page.path })),
        ...cmsEntries,
      ]),
    [config, staticPages, cmsEntries]
  );

  const snippetKb = useMemo(
    () => estimateSnippetKb(siteCustomCode),
    [siteCustomCode]
  );

  const updateConfig = useCallback(
    (patch: Partial<SchemaSiteConfig>) => {
      // Persist outside the updater — React may invoke updaters twice.
      const next = { ...config, ...patch };
      setConfig(next);
      saveSchemaConfig(next);
    },
    [config]
  );

  const updateMapping = useCallback(
    (collectionId: string, patch: Partial<CollectionSchemaMapping>) => {
      const next = collections.map((row) =>
        row.mapping.collectionId === collectionId
          ? { ...row, mapping: { ...row.mapping, ...patch } }
          : row
      );
      setCollections(next);
      saveCollectionMappings(next.map((row) => row.mapping));
    },
    [collections]
  );

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
      setError("Couldn't copy — select the text and copy it manually.");
    }
    setTimeout(() => setCopied(null), COPY_RESET_MS);
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setStatus(null);
    try {
      const stored = readStoredCollectionMappings();
      const [allCollections, pageNodes] = await Promise.all([
        framer.getCollections(),
        framer.getNodesWithType("WebPageNode"),
      ]);

      // Framer does not link a Collection to the page node that renders it, so
      // collect every templated path and match on name. Ambiguous cases are
      // left blank rather than guessed wrong — the field is editable.
      const templatePrefixes = pageNodes
        .map((page) => page.path ?? "")
        .filter((path) => path.includes("/:"))
        .map(prefixFromTemplate)
        .filter(Boolean);

      // Read every collection up front rather than awaiting inside the loop.
      const loaded = await Promise.all(
        allCollections.map(async (collection) => ({
          collection,
          fields: (await collection.getFields()) as FieldOption[],
          items: await collection.getItems(),
        }))
      );

      const rows: CollectionRow[] = [];
      const entries: PathGraphEntry[] = [];
      for (const { collection, fields, items } of loaded) {
        const existing = stored.find(
          (entry) => entry.collectionId === collection.id
        );
        const pathPrefix =
          existing?.pathPrefix ??
          matchTemplatePrefix(collection.name, templatePrefixes);
        const mapping: CollectionSchemaMapping = existing ?? {
          bodyFieldId: guessFieldId(fields, "body", BODY_FIELD_TYPES),
          collectionId: collection.id,
          collectionName: collection.name,
          datePublishedFieldId: guessFieldId(fields, "date", DATE_FIELD_TYPES),
          descriptionFieldId: guessFieldId(
            fields,
            "description",
            TEXT_FIELD_TYPES
          ),
          imageFieldId: guessFieldId(fields, "image", IMAGE_FIELD_TYPES),
          kind: guessCollectionKind(collection.name, pathPrefix),
          outputFieldId: guessFieldId(fields, "output", OUTPUT_FIELD_TYPES),
          pathPrefix,
          slugFieldName: "Slug",
          titleFieldId: guessFieldId(fields, "title", TEXT_FIELD_TYPES),
        };
        rows.push({ fields, itemCount: items.length, mapping });

        // CMS items go into the site snippet too, so every URL is covered with
        // no manual step. Reading the CMS is safe — nothing is written back.
        if (mapping.pathPrefix && mapping.titleFieldId) {
          for (const item of items) {
            const content = buildPageContentFromCmsItem({ item, mapping });
            entries.push({
              graph: buildPageGraph(config, content, { kind: mapping.kind }),
              path: content.path,
            });
          }
        }
      }

      const pages: StaticPageRow[] = [];
      for (const page of pageNodes) {
        const path = page.path ?? "";
        if (!path || path.includes("/:")) {
          continue;
        }
        const segments = path.split("/").filter(Boolean);
        const content: PageContent = {
          path,
          source: "canvas",
          title:
            segments.length > 0
              ? titleFromSlug(segments.at(-1) ?? "")
              : config.organizationName,
        };
        const graph = buildPageGraph(config, content);
        pages.push({
          graph,
          issues: validateGraph(graph, config),
          path,
          title: content.title,
        });
      }
      pages.sort((a, b) => a.path.localeCompare(b.path));

      setCollections(rows);
      setStaticPages(pages);
      setCmsEntries(entries);
      saveCollectionMappings(rows.map((row) => row.mapping));
      setStatus(
        `Found ${pages.length} static page(s), ${rows.length} collection(s), ${entries.length} CMS page(s) — ${
          pages.length + entries.length
        } URLs covered by the site snippet. Nothing was written; this only reads.`
      );
    } catch (scanError) {
      setError(`Scan failed: ${errorMessage(scanError)}`);
    } finally {
      setScanning(false);
    }
  }, [config]);

  const previewCollection = useCallback(
    async (row: CollectionRow) => {
      setBusy(row.mapping.collectionId);
      setError(null);
      try {
        const collections_ = await framer.getCollections();
        const collection = collections_.find(
          (entry) => entry.id === row.mapping.collectionId
        );
        if (!collection) {
          throw new Error("Collection is no longer in the project.");
        }
        const items = await collection.getItems();
        const preview: CmsPreviewRow[] = items
          .slice(0, PREVIEW_LIMIT)
          .map((item) => {
            const content = buildPageContentFromCmsItem({
              item,
              mapping: row.mapping,
            });
            const graph = buildPageGraph(config, content, {
              kind: row.mapping.kind,
            });
            return {
              issues: validateGraph(graph, config),
              itemId: item.id,
              path: content.path,
              value: serializeGraph(graph),
            };
          });
        setCmsPreview(preview);
        setStatus(
          `Previewing ${preview.length} of ${items.length} item(s) from ${row.mapping.collectionName}.`
        );
      } catch (previewError) {
        setError(`Preview failed: ${errorMessage(previewError)}`);
      } finally {
        setBusy(null);
      }
    },
    [config]
  );

  const writeCollection = useCallback(
    async (row: CollectionRow) => {
      const readiness = checkMappingReadiness(row.mapping);
      if (readiness.conflicts.length > 0) {
        setError(
          `Refusing to write: the schema output field is also the ${readiness.conflicts.join(
            " and "
          )} field. Writing would overwrite that content. Pick a dedicated plain text field.`
        );
        return;
      }
      if (!readiness.ready) {
        setError(`Still need: ${readiness.missing.join(", ")}.`);
        return;
      }
      setBusy(row.mapping.collectionId);
      setError(null);
      try {
        const collections_ = await framer.getCollections();
        const collection = collections_.find(
          (entry) => entry.id === row.mapping.collectionId
        );
        if (!collection) {
          throw new Error("Collection is no longer in the project.");
        }
        const items = await collection.getItems();
        let written = 0;
        const failures: string[] = [];
        for (const item of items) {
          const content = buildPageContentFromCmsItem({
            item,
            mapping: row.mapping,
          });
          const value = buildCmsFieldValue(config, content, {
            kind: row.mapping.kind,
          });
          try {
            // Sequential on purpose: this writes to the user's live CMS, and a
            // parallel burst across a large collection risks rate limits and
            // makes a partial failure much harder to reason about.
            // oxlint-disable-next-line eslint/no-await-in-loop
            await item.setAttributes({
              fieldData: {
                [row.mapping.outputFieldId]: { type: "string", value },
              },
            });
            written += 1;
          } catch (itemError) {
            failures.push(
              `${content.path} (${value.length} chars): ${errorMessage(itemError)}`
            );
          }
        }
        setStatus(
          [
            `Wrote schema to ${written} of ${items.length} item(s) in ${row.mapping.collectionName}.`,
            ...(failures.length > 0
              ? [
                  "",
                  `Failed (${failures.length}) — first ${Math.min(
                    failures.length,
                    FAILURE_DETAIL_LIMIT
                  )}:`,
                  ...failures.slice(0, FAILURE_DETAIL_LIMIT),
                ]
              : []),
          ].join("\n")
        );
        framer.notify(
          failures.length > 0
            ? `Wrote ${written} item(s), ${failures.length} failed.`
            : `Wrote schema to ${written} item(s).`,
          { variant: failures.length > 0 ? "warning" : "success" }
        );
      } catch (writeError) {
        setError(`Write failed: ${errorMessage(writeError)}`);
      } finally {
        setBusy(null);
      }
    },
    [config]
  );

  const publishSiteGraph = useCallback(async () => {
    setBusy("site");
    setError(null);
    try {
      await framer.setCustomCode({
        html: siteCustomCode,
        location: "headStart",
      });
      setStatus(
        `Site snippet written (${snippetKb} KB, ${
          staticPages.length + cmsEntries.length
        } page(s)). Republish the site for it to go live.`
      );
      framer.notify("Site snippet written to custom code.", {
        variant: "success",
      });
    } catch (publishError) {
      setError(`Couldn't write custom code: ${errorMessage(publishError)}`);
    } finally {
      setBusy(null);
    }
  }, [siteCustomCode, snippetKb, staticPages.length, cmsEntries.length]);

  const totalIssues = useMemo(
    () =>
      staticPages.reduce((sum, page) => sum + page.issues.length, 0) +
      cmsPreview.reduce((sum, item) => sum + item.issues.length, 0),
    [staticPages, cmsPreview]
  );

  return (
    <section className="panel">
      <div className="panel-topline">
        <div>
          <div className="panel-label">Structured data</div>
          <div className="panel-muted">
            Reads your pages and CMS collections and generates JSON-LD for every
            URL on the site. The output is one snippet for Site Settings →
            Custom Code. It does not modify any page or CMS content.
          </div>
        </div>
      </div>

      <div className="schema__actions">
        <button
          className="btn btn--primary"
          disabled={scanning}
          onClick={() => void scan()}
          type="button"
        >
          {scanning ? "Scanning…" : "Scan project"}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowSettings((current) => !current)}
          type="button"
        >
          {showSettings ? "Hide organization details" : "Organization details"}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowCmsWrite((current) => !current)}
          type="button"
        >
          {showCmsWrite ? "Hide CMS write" : "Advanced: CMS write"}
        </button>
      </div>

      {status ? (
        <pre className="schema__status schema__status--log">{status}</pre>
      ) : null}
      {error ? (
        <div className="schema__status schema__status--error">{error}</div>
      ) : null}
      {totalIssues > 0 ? (
        <div className="schema__status schema__status--error">
          {totalIssues} validation issue(s) below — fix before publishing.
        </div>
      ) : null}

      {showSettings ? (
        <div className="check-grid">
          <label>
            <span>Canonical origin</span>
            <input
              className="form-control"
              onChange={(event) => updateConfig({ origin: event.target.value })}
              placeholder={DEFAULT_SCHEMA_CONFIG.origin}
              type="text"
              value={config.origin}
            />
          </label>
          <label>
            <span>Organization name</span>
            <input
              className="form-control"
              onChange={(event) =>
                updateConfig({ organizationName: event.target.value })
              }
              type="text"
              value={config.organizationName}
            />
          </label>
          <label>
            <span>Description</span>
            <textarea
              className="form-control"
              onChange={(event) =>
                updateConfig({ description: event.target.value })
              }
              rows={3}
              value={config.description}
            />
          </label>
          <label>
            <span>Logo URL</span>
            <input
              className="form-control"
              onChange={(event) =>
                updateConfig({ logoUrl: event.target.value })
              }
              type="text"
              value={config.logoUrl ?? ""}
            />
          </label>
          <label>
            <span>Profile URLs (sameAs, one per line)</span>
            <textarea
              className="form-control"
              onChange={(event) =>
                updateConfig({
                  sameAs: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }
              rows={3}
              value={(config.sameAs ?? []).join("\n")}
            />
          </label>
        </div>
      ) : null}

      <div className="schema__section">
        <div className="schema__section-head">
          <span>Site snippet</span>
          <span className="panel-muted">
            {staticPages.length + cmsEntries.length} page(s) · {snippetKb} KB
          </span>
        </div>
        <div className="panel-muted">
          Paste into Site Settings → Custom Code (head), or let the plugin write
          it for you. Organization and WebSite are emitted as static JSON-LD;
          the per-page graphs sit in a JSON block and the matching one is
          applied on load, since a site-wide snippet is identical on every page.
        </div>
        <div className="schema__actions">
          <button
            className="btn btn--primary"
            disabled={!canSetCustomCode || busy === "site"}
            onClick={() => void publishSiteGraph()}
            type="button"
          >
            {busy === "site"
              ? "Writing…"
              : `Write site snippet (${
                  staticPages.length + cmsEntries.length
                } page(s))`}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void copy("site", siteCustomCode)}
            type="button"
          >
            {copied === "site" ? "Copied" : "Copy"}
          </button>
        </div>
        {canSetCustomCode ? null : (
          <div className="panel-muted">
            You don’t have permission to set custom code in this project — copy
            it and paste it into Site Settings instead.
          </div>
        )}
        <pre className="schema__code">{siteCustomCode}</pre>
      </div>

      {collections.map((row) => {
        const readiness = checkMappingReadiness(row.mapping);
        // Only offer fields whose stored type matches what we write, so the
        // dropdown can't produce a mapping the CMS will reject.
        const textFields = fieldsOfType(row.fields, TEXT_FIELD_TYPES);
        // A field we read from must never appear as a write target.
        const readRoleIds = new Set(
          [
            row.mapping.titleFieldId,
            row.mapping.descriptionFieldId,
            row.mapping.bodyFieldId,
            row.mapping.datePublishedFieldId,
            row.mapping.imageFieldId,
          ].filter(Boolean)
        );
        const outputFields = fieldsOfType(
          row.fields,
          OUTPUT_FIELD_TYPES
        ).filter((field) => !readRoleIds.has(field.id));
        // Framer substitutes by field NAME, so resolve ids back to names.
        const nameOf = (fieldId: string): string | undefined =>
          row.fields.find((field) => field.id === fieldId)?.name;
        const templateSnippet = row.mapping.pathPrefix
          ? buildCmsTemplateSnippet(config, {
              fieldNames: {
                datePublished: nameOf(row.mapping.datePublishedFieldId),
                description: nameOf(row.mapping.descriptionFieldId),
                image: nameOf(row.mapping.imageFieldId),
                slug: row.mapping.slugFieldName || "Slug",
                title: nameOf(row.mapping.titleFieldId),
              },
              kind: row.mapping.kind,
              pathPrefix: row.mapping.pathPrefix,
            })
          : "";
        const bodyFields = fieldsOfType(row.fields, BODY_FIELD_TYPES);
        const imageFields = fieldsOfType(row.fields, IMAGE_FIELD_TYPES);
        const dateFields = fieldsOfType(row.fields, DATE_FIELD_TYPES);
        return (
          <div className="schema__section" key={row.mapping.collectionId}>
            <div className="schema__section-head">
              <span>{row.mapping.collectionName}</span>
              <span className="panel-muted">{row.itemCount} item(s)</span>
            </div>
            <div className="panel-muted">
              Fields:{" "}
              {row.fields.length === 0
                ? "none found"
                : row.fields
                    .map((field) => `${field.name} (${field.type})`)
                    .join(", ")}
            </div>
            <div className="check-grid">
              <label>
                <span>Published path prefix</span>
                <input
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      pathPrefix: event.target.value,
                    })
                  }
                  placeholder="/case-studies"
                  type="text"
                  value={row.mapping.pathPrefix}
                />
              </label>
              <label>
                <span>Schema type</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      kind: event.target
                        .value as CollectionSchemaMapping["kind"],
                    })
                  }
                  value={row.mapping.kind}
                >
                  <option value="caseStudy">Case study (Article)</option>
                  <option value="blogPost">Blog post (BlogPosting)</option>
                  <option value="guide">Guide (TechArticle)</option>
                  <option value="service">Service</option>
                  <option value="generic">Plain page (WebPage)</option>
                </select>
              </label>
              <label>
                <span>Title field</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      titleFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.titleFieldId}
                >
                  <option value="">— none —</option>
                  {textFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Description field</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      descriptionFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.descriptionFieldId}
                >
                  <option value="">— none —</option>
                  {textFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Image field</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      imageFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.imageFieldId}
                >
                  <option value="">— none —</option>
                  {imageFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Body field</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      bodyFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.bodyFieldId}
                >
                  <option value="">— none —</option>
                  {bodyFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Date field</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      datePublishedFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.datePublishedFieldId}
                >
                  <option value="">— none —</option>
                  {dateFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Write schema into (plain text field)</span>
                <select
                  className="form-control"
                  onChange={(event) =>
                    updateMapping(row.mapping.collectionId, {
                      outputFieldId: event.target.value,
                    })
                  }
                  value={row.mapping.outputFieldId}
                >
                  <option value="">— none —</option>
                  {outputFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name} ({field.type})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {readiness.conflicts.length > 0 ? (
              <div className="schema__status schema__status--error">
                The schema output field is also this collection’s{" "}
                {readiness.conflicts.join(" and ")} field. Writing would
                overwrite that content — pick a dedicated plain text field
                before running this.
              </div>
            ) : null}
            {outputFields.length === 0 ? (
              <div className="panel-muted">
                This collection has no plain text field, so there is nowhere to
                write the schema. Add one in the CMS (name it “Schema JSON”) and
                scan again.
              </div>
            ) : null}
            {readiness.ready ? null : (
              <div className="panel-muted">
                Still need: {readiness.missing.join(", ")}.
              </div>
            )}
            <label>
              <span>Slug field name (as Framer shows it)</span>
              <input
                className="form-control"
                onChange={(event) =>
                  updateMapping(row.mapping.collectionId, {
                    slugFieldName: event.target.value,
                  })
                }
                placeholder="Slug"
                type="text"
                value={row.mapping.slugFieldName ?? ""}
              />
            </label>
            <div className="panel-muted">
              These items are already covered by the site snippet above —
              nothing here is required. Optional upgrade: paste this into the
              collection’s <strong>page template</strong> → Page Settings →
              Custom Code, end of <code>&lt;head&gt;</code> (not the index
              page). Framer fills in each {"{{Field}}"} per item, which puts the
              JSON-LD in the static HTML so crawlers that skip JavaScript see it
              too. One paste per collection, then it stays current on its own.
            </div>
            <div className="schema__actions">
              <button
                className="btn btn--primary"
                disabled={!templateSnippet}
                onClick={() =>
                  void copy(`tpl-${row.mapping.collectionId}`, templateSnippet)
                }
                type="button"
              >
                {copied === `tpl-${row.mapping.collectionId}`
                  ? "Copied"
                  : "Copy template snippet"}
              </button>
              <button
                className="btn btn--ghost"
                disabled={busy === row.mapping.collectionId}
                onClick={() => void previewCollection(row)}
                type="button"
              >
                Preview with real data
              </button>
            </div>
            {templateSnippet ? (
              <pre className="schema__code">{templateSnippet}</pre>
            ) : (
              <div className="panel-muted">
                Set the published path prefix above to generate the snippet.
              </div>
            )}
            {showCmsWrite ? (
              <div className="schema__optional">
                <div className="panel-muted">
                  Optional: also store each item’s JSON in a CMS field, so the
                  collection template can render it into the head statically.
                  Only crawlers that skip JavaScript benefit. This writes to the
                  CMS — it needs a dedicated plain text field that holds nothing
                  else.
                </div>
                <button
                  className="btn"
                  disabled={
                    !(canUpdateItems && readiness.ready) ||
                    busy === row.mapping.collectionId
                  }
                  onClick={() => void writeCollection(row)}
                  type="button"
                >
                  {busy === row.mapping.collectionId
                    ? "Writing…"
                    : `Write to CMS field (${row.itemCount} item(s))`}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      {cmsPreview.length > 0 ? (
        <div className="schema__section">
          <div className="schema__section-head">
            <span>Preview</span>
          </div>
          {cmsPreview.map((item) => (
            <div className="schema__row" key={item.itemId}>
              <div className="schema__row-head">
                <span>{item.path}</span>
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => void copy(item.itemId, item.value)}
                  type="button"
                >
                  {copied === item.itemId ? "Copied" : "Copy"}
                </button>
              </div>
              {item.issues.map((issue) => (
                <div
                  className="schema__issue"
                  key={`${item.itemId}-${issue.message}`}
                >
                  {issue.severity === "error" ? "Error" : "Warning"}:{" "}
                  {issue.message}
                </div>
              ))}
              <pre className="schema__code">{item.value}</pre>
            </div>
          ))}
        </div>
      ) : null}

      {staticPages.length > 0 ? (
        <div className="schema__section">
          <div className="schema__section-head">
            <span>Static pages covered</span>
            <span className="panel-muted">
              Included in the site snippet above — nothing to paste per page.
            </span>
          </div>
          {staticPages.map((page) => (
            <div className="schema__row" key={page.path}>
              <div className="schema__row-head">
                <span>
                  {page.path} · {classifyPath(page.path)}
                </span>
                <span className="panel-muted">
                  {page.issues.length === 0
                    ? "OK"
                    : `${page.issues.length} issue(s)`}
                </span>
              </div>
              {page.issues.map((issue) => (
                <div
                  className="schema__issue"
                  key={`${page.path}-${issue.message}`}
                >
                  {issue.severity === "error" ? "Error" : "Warning"}:{" "}
                  {issue.message}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
};
