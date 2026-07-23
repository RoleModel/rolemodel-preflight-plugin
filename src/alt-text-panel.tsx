import { framer, useIsAllowedTo } from "@framer/plugin";
import React, { useCallback, useEffect, useState } from "react";

import {
  applyCandidateAltText,
  collectAltTextCandidates,
  collectCanvasAltTextCandidates,
  findPreferredSeoTitleFieldId,
  generateAltTextWithClaude,
  getCmsImageFields,
  getCmsTextFields,
} from "./lib/alt-text";
import type { AltTextCandidate, AltTextFieldOption } from "./lib/alt-text";
import {
  clearStoredAnthropicApiKey,
  readStoredAnthropicApiKey,
  saveAnthropicApiKey,
} from "./lib/api-key-storage";

type GenerationMode = "claude" | "seoTitle";
type ImageSource = "canvas" | "cms";

interface AltTextCandidateListProps {
  canUpdate: boolean;
  candidates: AltTextCandidate[];
  confirmed: boolean;
  onApply: () => void;
  onChangeAltText: (id: string, altText: string) => void;
  onConfirmedChange: (confirmed: boolean) => void;
  onGoToLayer: (candidate: AltTextCandidate) => void;
  source: ImageSource;
  working: boolean;
}

const AltTextCandidateList = ({
  canUpdate,
  candidates,
  confirmed,
  onApply,
  onChangeAltText,
  onConfirmedChange,
  onGoToLayer,
  source,
  working,
}: AltTextCandidateListProps) => {
  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="alt-text-list">
      {candidates.map((candidate) => (
        <article className="alt-text-row" key={candidate.id}>
          <img
            alt=""
            className="alt-text-row__thumbnail"
            src={candidate.image.thumbnailUrl}
          />
          <div className="alt-text-row__content">
            <strong>
              {candidate.contextLabel} · {candidate.locationLabel}
            </strong>
            <span className="panel-muted">
              {candidate.source === "cms" ? "SEO title" : "Layer context"}:{" "}
              {candidate.seoTitle}
            </span>
            <textarea
              aria-label={`Alt text for ${candidate.contextLabel}`}
              className="form-control"
              maxLength={160}
              onChange={(event) =>
                onChangeAltText(candidate.id, event.target.value)
              }
              rows={2}
              value={candidate.altText}
            />
            <span className="panel-muted">
              {candidate.altText.length}/160 characters
              {candidate.existingAltText
                ? ` · Current: ${candidate.existingAltText}`
                : ""}
            </span>
            {candidate.generationError ? (
              <span className="font-manager__status--error">
                Claude failed: {candidate.generationError}
              </span>
            ) : null}
            {candidate.node ? (
              <button
                className="btn"
                onClick={() => onGoToLayer(candidate)}
                type="button"
              >
                {candidate.node.isReplica
                  ? "Go to source layer"
                  : "Go to layer"}
              </button>
            ) : null}
          </div>
        </article>
      ))}

      <label className="optimizer-checkbox optimizer-confirmation">
        <input
          checked={confirmed}
          disabled={working}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          type="checkbox"
        />
        <span>
          Update the alt text for {candidates.length}{" "}
          {source === "cms" ? "CMS" : "canvas"} image
          {candidates.length === 1 ? "" : "s"}.
        </span>
      </label>
      <button
        className="btn btn--primary btn--medium"
        disabled={working || !confirmed || !canUpdate}
        onClick={onApply}
        type="button"
      >
        Apply alt text
      </button>
    </div>
  );
};

const resolveStableCanvasNodeId = async (
  nodeId: string
): Promise<string | null> => {
  try {
    let currentNode = await framer.getNode(nodeId);
    let depth = 0;
    while (currentNode?.isReplica && depth < 12) {
      // Parent lookup is sequential because each result determines the next id.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      currentNode = await currentNode.getParent();
      depth += 1;
    }
    return currentNode?.id ?? null;
  } catch {
    return null;
  }
};

const isCanvasNodeSelected = async (nodeId: string): Promise<boolean> => {
  try {
    const selection = await framer.getSelection();
    return selection.some((node) => node.id === nodeId);
  } catch {
    return false;
  }
};

const tryNavigateToCanvasNode = async (
  nodeId: string,
  originalId: string | null = null
): Promise<boolean> => {
  const stableNodeId = await resolveStableCanvasNodeId(nodeId);
  const targetIds = [
    ...new Set(
      [originalId, stableNodeId, nodeId].filter(
        (id): id is string => typeof id === "string"
      )
    ),
  ];
  for (const targetId of targetIds) {
    try {
      // Try both the resolved id and the original canvas-scope id in order.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      await framer.navigateTo(targetId, {
        select: true,
        zoomIntoView: { maxZoom: 1 },
      });
      // Framer can resolve navigation for an unreachable replica without
      // changing the canvas. Only stop when the target is actually selected.
      // oxlint-disable-next-line eslint/no-await-in-loop -- navigation verification
      if (await isCanvasNodeSelected(targetId)) {
        return true;
      }
    } catch {
      // Continue to the original id or an ancestor below.
    }
  }

  let currentId = nodeId;
  let depth = 0;
  while (depth < 12) {
    let parent: Awaited<ReturnType<typeof framer.getParent>>;
    try {
      // Ancestor lookup must be sequential because each parent supplies the next id.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      parent = await framer.getParent(currentId);
    } catch {
      return false;
    }
    if (!parent) {
      return false;
    }
    try {
      // Replica contents may be unreachable while their containing instance is valid.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      await framer.navigateTo(parent.id, {
        select: true,
        zoomIntoView: { maxZoom: 1 },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- navigation verification
      if (await isCanvasNodeSelected(parent.id)) {
        return true;
      }
      currentId = parent.id;
      depth += 1;
    } catch {
      currentId = parent.id;
      depth += 1;
    }
  }
  return false;
};

const tryNavigateWithNodeHandle = async (
  node: NonNullable<AltTextCandidate["node"]>
): Promise<boolean> => {
  if (!node.isReplica) {
    try {
      await node.navigateTo({
        select: true,
        zoomIntoView: { maxZoom: 1 },
      });
      if (await isCanvasNodeSelected(node.id)) {
        return true;
      }
    } catch {
      // Some canvas scopes require selection and zoom as separate operations.
    }

    try {
      await node.select();
      await node.zoomIntoView({ maxZoom: 1 });
      if (await isCanvasNodeSelected(node.id)) {
        return true;
      }
    } catch {
      // Walk the live parent chain below for component replicas.
    }
  }

  let currentNode: Awaited<ReturnType<typeof node.getParent>> = node;
  let depth = 0;
  while (currentNode && depth < 12) {
    try {
      // Parent handles remain usable in scopes where global id lookup fails.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      currentNode = await currentNode.getParent();
    } catch {
      return false;
    }
    if (!currentNode) {
      return false;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- ancestor search
      await currentNode.navigateTo({
        select: true,
        zoomIntoView: { maxZoom: 1 },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- navigation verification
      if (await isCanvasNodeSelected(currentNode.id)) {
        return true;
      }
    } catch {
      // Continue climbing when Framer rejects this canvas scope.
    }
    depth += 1;
  }
  return false;
};

interface AltTextGenerationResult {
  altText?: string;
  generationError?: string;
  id: string;
}

const generateCandidateAltTexts = async (
  apiKey: string,
  candidates: readonly AltTextCandidate[],
  onProgress: (message: string) => void
): Promise<AltTextGenerationResult[]> => {
  const generationCandidates = candidates.some(
    (candidate) => candidate.generationError
  )
    ? candidates.filter((candidate) => candidate.generationError)
    : candidates;
  const results: AltTextGenerationResult[] = [];

  for (const [index, candidate] of generationCandidates.entries()) {
    onProgress(
      `Claude is describing image ${index + 1} of ${generationCandidates.length}: ${candidate.contextLabel}…`
    );
    try {
      // Sequential requests keep API usage predictable and make progress visible.
      // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
      const altText = await generateAltTextWithClaude({ apiKey, candidate });
      results.push({ altText, id: candidate.id });
    } catch (error) {
      results.push({
        generationError: error instanceof Error ? error.message : String(error),
        id: candidate.id,
      });
    }
  }

  return results;
};

// This component coordinates two scan sources, permission-gated writes, and
// progress UI; its individual scan/generation/navigation operations are
// extracted above.
// oxlint-disable-next-line eslint/complexity -- orchestration branches
export const AltTextPanel = () => {
  const canUpdateItems = useIsAllowedTo("CollectionItem.setAttributes");
  const canUpdateCanvas = useIsAllowedTo("Node.setAttributes");
  const [source, setSource] = useState<ImageSource>("cms");
  const [collections, setCollections] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [imageFields, setImageFields] = useState<AltTextFieldOption[]>([]);
  const [textFields, setTextFields] = useState<AltTextFieldOption[]>([]);
  const [selectedImageFieldId, setSelectedImageFieldId] = useState("all");
  const [selectedTitleFieldId, setSelectedTitleFieldId] = useState("");
  const [includeExisting, setIncludeExisting] = useState(false);
  const [mode, setMode] = useState<GenerationMode>("seoTitle");
  const [apiKey, setApiKey] = useState(readStoredAnthropicApiKey);
  const [candidates, setCandidates] = useState<AltTextCandidate[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("Loading editable CMS collections…");

  const loadCollections = useCallback(async () => {
    setWorking(true);
    try {
      const allCollections = await framer.getCollections();
      const available = allCollections
        .filter((collection) => collection.managedBy === "user")
        .map((collection) => ({ id: collection.id, name: collection.name }));
      setCollections(available);
      setSelectedCollectionId((current) => current || available[0]?.id || "");
      setStatus(
        available.length > 0
          ? `Found ${available.length} editable CMS collection${available.length === 1 ? "" : "s"}.`
          : "No editable user CMS collections are available."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    // Loading begins on mount and owns its status lifecycle.
    // oxlint-disable-next-line react/react-compiler -- see comment above
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    // Clear collection-specific results immediately so the UI cannot show
    // candidates or field choices belonging to the previous collection.
    // oxlint-disable-next-line react/react-compiler -- see comment above
    setCandidates([]);
    setConfirmed(false);
    setSelectedImageFieldId("all");
    if (!selectedCollectionId) {
      setImageFields([]);
      setTextFields([]);
      setSelectedTitleFieldId("");
      return;
    }

    void (async () => {
      const allCollections = await framer.getCollections();
      const collection = allCollections.find(
        (entry) => entry.id === selectedCollectionId
      );
      if (!collection) {
        return;
      }
      const fields = await collection.getFields();
      const nextImageFields = getCmsImageFields(fields);
      const nextTextFields = getCmsTextFields(fields);
      setImageFields(nextImageFields);
      setTextFields(nextTextFields);
      setSelectedTitleFieldId(findPreferredSeoTitleFieldId(nextTextFields));
    })();
  }, [selectedCollectionId]);

  const getSelectedCollection = useCallback(async () => {
    const allCollections = await framer.getCollections();
    const collection = allCollections.find(
      (entry) => entry.id === selectedCollectionId
    );
    if (!collection) {
      throw new Error("Select an editable CMS collection first.");
    }
    return collection;
  }, [selectedCollectionId]);

  const handleScan = useCallback(async () => {
    setWorking(true);
    setConfirmed(false);
    setStatus(`Scanning ${source === "cms" ? "CMS" : "canvas"} images…`);
    try {
      const nextCandidates =
        source === "canvas"
          ? collectCanvasAltTextCandidates(
              await framer.getNodesWithAttributeSet("backgroundImage"),
              includeExisting
            )
          : await collectAltTextCandidates(
              await getSelectedCollection(),
              selectedImageFieldId,
              selectedTitleFieldId,
              includeExisting
            );
      setCandidates(nextCandidates);
      setStatus(
        `Ready: ${nextCandidates.length} image${nextCandidates.length === 1 ? "" : "s"}. Review the proposed alt text before applying it.`
      );
    } catch (error) {
      setCandidates([]);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }, [
    getSelectedCollection,
    includeExisting,
    selectedImageFieldId,
    selectedTitleFieldId,
    source,
  ]);

  const handleGenerateWithClaude = useCallback(async () => {
    if (!apiKey.trim()) {
      setStatus("Enter an Anthropic API key first.");
      return;
    }
    setWorking(true);
    const results = await generateCandidateAltTexts(
      apiKey,
      candidates,
      setStatus
    );
    const resultsById = new Map(results.map((result) => [result.id, result]));
    setCandidates((current) =>
      current.map((candidate) => {
        const result = resultsById.get(candidate.id);
        if (!result) {
          return candidate;
        }
        return result.altText === undefined
          ? { ...candidate, generationError: result.generationError }
          : {
              ...candidate,
              altText: result.altText,
              generationError: undefined,
            };
      })
    );
    const generatedCount = results.filter(
      (result) => result.altText !== undefined
    ).length;
    const failedCount = results.length - generatedCount;
    setStatus(
      `Claude finished: generated ${generatedCount}, failed ${failedCount}. Review successful descriptions and retry failed images if needed.`
    );
    setWorking(false);
  }, [apiKey, candidates]);

  const handleGoToLayer = useCallback(async (candidate: AltTextCandidate) => {
    if (!candidate.node) {
      return;
    }

    if (await tryNavigateWithNodeHandle(candidate.node)) {
      setStatus(`Opened canvas layer: ${candidate.contextLabel}.`);
      return;
    }

    if (
      await tryNavigateToCanvasNode(
        candidate.node.id,
        candidate.node.originalId
      )
    ) {
      setStatus(`Opened canvas layer: ${candidate.contextLabel}.`);
      return;
    }

    try {
      const frameNodes =
        await framer.getNodesWithAttributeSet("backgroundImage");
      const currentNode = frameNodes.find(
        (node) => node.backgroundImage?.url === candidate.image.url
      );
      if (currentNode) {
        if (await tryNavigateWithNodeHandle(currentNode)) {
          setStatus(`Opened canvas layer: ${candidate.contextLabel}.`);
          return;
        }
        if (
          await tryNavigateToCanvasNode(currentNode.id, currentNode.originalId)
        ) {
          setStatus(`Opened canvas layer: ${candidate.contextLabel}.`);
          return;
        }
      }
    } catch {
      // Show one controlled failure after both navigation strategies.
    }

    const message =
      "Framer found this image but could not open its layer directly. It may be inside a component replica or another canvas scope.";
    setStatus(message);
    await framer.notify(message, { variant: "error" });
  }, []);

  const handleApply = useCallback(async () => {
    const hasPermission =
      source === "canvas" ? canUpdateCanvas : canUpdateItems;
    if (!confirmed || !hasPermission) {
      setStatus("Confirm the update and grant permission first.");
      return;
    }
    const readyCandidates = candidates.filter(
      (candidate) => candidate.altText.trim().length > 0
    );
    setWorking(true);
    let updatedCount = 0;
    let failedCount = 0;
    for (const [index, candidate] of readyCandidates.entries()) {
      setStatus(
        `Updating ${index + 1} of ${readyCandidates.length}: ${candidate.contextLabel}…`
      );
      try {
        // Writes are intentionally sequential to avoid bridge instability.
        // oxlint-disable-next-line eslint/no-await-in-loop -- see comment above
        await applyCandidateAltText(candidate);
        updatedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    setWorking(false);
    setConfirmed(false);
    setStatus(
      `Complete: updated ${updatedCount} image${updatedCount === 1 ? "" : "s"}, ${failedCount} failed.`
    );
    await framer.notify(`Added alt text to ${updatedCount} images.`, {
      variant: failedCount > 0 ? "warning" : "success",
    });
  }, [canUpdateCanvas, canUpdateItems, candidates, confirmed, source]);

  const failedCandidateCount = candidates.filter(
    (candidate) => candidate.generationError
  ).length;

  return (
    <section className="panel optimizer-panel">
      <div className="panel-topline">
        <div>
          <div className="panel-label">Alt Text Generator</div>
          <div className="panel-muted">
            Scan CMS and canvas images, then use SEO context or Claude to write
            accurate alt text.
          </div>
        </div>
        <button
          className="btn"
          onClick={() => void loadCollections()}
          type="button"
        >
          Refresh collections
        </button>
      </div>

      <div className="optimizer-form">
        <div className="header-actions">
          <button
            className={`btn${source === "cms" ? " btn--active" : ""}`}
            onClick={() => {
              setSource("cms");
              setCandidates([]);
              setConfirmed(false);
            }}
            type="button"
          >
            CMS images
          </button>
          <button
            className={`btn${source === "canvas" ? " btn--active" : ""}`}
            onClick={() => {
              setSource("canvas");
              setCandidates([]);
              setConfirmed(false);
            }}
            type="button"
          >
            Canvas images
          </button>
        </div>

        {source === "cms" ? (
          <>
            <div className="optimizer-form__row">
              <label>
                <span>CMS collection</span>
                <select
                  disabled={working}
                  onChange={(event) =>
                    setSelectedCollectionId(event.target.value)
                  }
                  value={selectedCollectionId}
                >
                  <option value="">Choose a collection</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Image field</span>
                <select
                  disabled={working || imageFields.length === 0}
                  onChange={(event) =>
                    setSelectedImageFieldId(event.target.value)
                  }
                  value={selectedImageFieldId}
                >
                  <option value="all">All image fields</option>
                  {imageFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label>
              <span>SEO title field</span>
              <select
                disabled={working || textFields.length === 0}
                onChange={(event) =>
                  setSelectedTitleFieldId(event.target.value)
                }
                value={selectedTitleFieldId}
              >
                {textFields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p className="panel-muted">
            Canvas mode scans image backgrounds across project layers. Layer
            names provide context for the initial proposal and Claude prompt.
          </p>
        )}

        <div className="header-actions">
          <button
            className={`btn${mode === "seoTitle" ? " btn--active" : ""}`}
            onClick={() => setMode("seoTitle")}
            type="button"
          >
            Use SEO title
          </button>
          <button
            className={`btn${mode === "claude" ? " btn--active" : ""}`}
            onClick={() => setMode("claude")}
            type="button"
          >
            Generate with Claude
          </button>
        </div>

        {mode === "claude" ? (
          <label>
            <span>Anthropic API key</span>
            <input
              autoComplete="off"
              className="form-control"
              onChange={(event) => {
                const nextApiKey = event.target.value;
                setApiKey(nextApiKey);
                if (!saveAnthropicApiKey(nextApiKey)) {
                  setStatus(
                    "The API key could not be saved in this browser. You can still use it for this session."
                  );
                }
              }}
              placeholder="sk-ant-…"
              type="password"
              value={apiKey}
            />
            <span className="panel-muted">
              Saved only in this browser and sent directly to Anthropic.
            </span>
            <span>
              <button
                className="btn"
                disabled={!apiKey}
                onClick={() => {
                  const cleared = clearStoredAnthropicApiKey();
                  setApiKey("");
                  setStatus(
                    cleared
                      ? "Anthropic API key cleared from this browser."
                      : "The saved API key could not be cleared from this browser."
                  );
                }}
                type="button"
              >
                Clear key
              </button>
            </span>
          </label>
        ) : null}

        <label className="optimizer-checkbox">
          <input
            checked={includeExisting}
            disabled={working}
            onChange={(event) => setIncludeExisting(event.target.checked)}
            type="checkbox"
          />
          <span>Include images that already have alt text</span>
        </label>

        <button
          className="btn btn--medium"
          disabled={
            working ||
            (source === "cms" &&
              (!selectedCollectionId ||
                imageFields.length === 0 ||
                !selectedTitleFieldId))
          }
          onClick={() => void handleScan()}
          type="button"
        >
          {working
            ? "Working…"
            : `Scan ${source === "cms" ? "CMS" : "canvas"} images`}
        </button>

        {mode === "claude" && candidates.length > 0 ? (
          <button
            className="btn btn--primary btn--medium"
            disabled={working || !apiKey.trim()}
            onClick={() => void handleGenerateWithClaude()}
            type="button"
          >
            {failedCandidateCount > 0 ? "Retry" : "Generate"}{" "}
            {failedCandidateCount || candidates.length} description
            {(failedCandidateCount || candidates.length) === 1 ? "" : "s"} with
            Claude
          </button>
        ) : null}
      </div>

      <AltTextCandidateList
        canUpdate={source === "cms" ? canUpdateItems : canUpdateCanvas}
        candidates={candidates}
        confirmed={confirmed}
        onApply={() => void handleApply()}
        onChangeAltText={(id, altText) =>
          setCandidates((current) =>
            current.map((candidate) =>
              candidate.id === id ? { ...candidate, altText } : candidate
            )
          )
        }
        onConfirmedChange={setConfirmed}
        onGoToLayer={(candidate) => void handleGoToLayer(candidate)}
        source={source}
        working={working}
      />

      <pre aria-live="polite" className="report report--compact">
        {status}
      </pre>
    </section>
  );
};
