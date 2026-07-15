import { framer, useIsAllowedTo } from "framer-plugin";
import React, { useCallback, useEffect, useState } from "react";

import {
  collectImageCandidates,
  getImageFields,
  optimizeCmsImage,
} from "./lib/image-optimizer";

export function ImageOptimizerPanel() {
  const canUpdateItems = useIsAllowedTo("CollectionItem.setAttributes");
  const [collections, setCollections] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [imageFields, setImageFields] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedFieldId, setSelectedFieldId] = useState("all");
  const [maxDimension, setMaxDimension] = useState(2400);
  const [quality, setQuality] = useState(82);
  const [skipWebp, setSkipWebp] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [candidateCount, setCandidateCount] = useState<number | null>(null);
  const [status, setStatus] = useState("Loading editable CMS collections…");
  const [working, setWorking] = useState(false);

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
          : "No editable user CMS collections are available in this mode."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    setCandidateCount(null);
    setConfirmed(false);
    setSelectedFieldId("all");
    if (!selectedCollectionId) {
      setImageFields([]);
      return;
    }
    void (async () => {
      const allCollections = await framer.getCollections();
      const collection = allCollections.find(
        (entry) => entry.id === selectedCollectionId
      );
      setImageFields(
        collection ? getImageFields(await collection.getFields()) : []
      );
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
    setStatus("Scanning CMS image fields…");
    try {
      const candidates = await collectImageCandidates(
        await getSelectedCollection(),
        selectedFieldId
      );
      setCandidateCount(candidates.length);
      setStatus(
        `Ready: ${candidates.length} image${candidates.length === 1 ? "" : "s"}. No CMS data has changed.`
      );
    } catch (error) {
      setCandidateCount(null);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }, [getSelectedCollection, selectedFieldId]);

  const handleOptimize = useCallback(async () => {
    if (!canUpdateItems || !confirmed) {
      setStatus(
        "Confirm replacement and grant the required permissions first."
      );
      return;
    }
    setWorking(true);
    try {
      const candidates = await collectImageCandidates(
        await getSelectedCollection(),
        selectedFieldId
      );
      let optimizedCount = 0;
      let skippedCount = 0;
      let beforeBytes = 0;
      let afterBytes = 0;

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        setStatus(
          `Optimizing ${index + 1} of ${candidates.length}: ${candidate.item.slug}…`
        );
        const result = await optimizeCmsImage(candidate, {
          maxDimension,
          quality: quality / 100,
          skipWebp,
        });
        beforeBytes += result.beforeBytes;
        afterBytes += result.afterBytes;
        if (result.skipped) {
          skippedCount += 1;
        } else {
          optimizedCount += 1;
        }
      }

      const savedMb = Math.max(0, beforeBytes - afterBytes) / 1024 / 1024;
      setStatus(
        `Complete: optimized ${optimizedCount}, skipped ${skippedCount}. Approximate reduction: ${savedMb.toFixed(2)} MB.`
      );
      setConfirmed(false);
      await framer.notify(`Optimized ${optimizedCount} CMS images as WebP.`, {
        variant: "success",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Image optimization stopped: ${message}`);
      await framer.notify(`Image optimization failed: ${message}`, {
        variant: "error",
      });
    } finally {
      setWorking(false);
    }
  }, [
    canUpdateItems,
    confirmed,
    getSelectedCollection,
    maxDimension,
    quality,
    selectedFieldId,
    skipWebp,
  ]);

  return (
    <section className="panel optimizer-panel">
      <div className="panel-topline">
        <span className="panel-label">CMS Image Optimizer</span>
        <button className="btn" onClick={() => void loadCollections()}>
          Refresh collections
        </button>
      </div>
      <p className="panel-muted">
        Scan first, then convert JPEG and PNG CMS images to WebP and replace
        their image-field references in place.
      </p>

      <div className="optimizer-form">
        <label>
          <span>CMS collection</span>
          <select
            value={selectedCollectionId}
            onChange={(event) => setSelectedCollectionId(event.target.value)}
            disabled={working}
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
            value={selectedFieldId}
            onChange={(event) => {
              setSelectedFieldId(event.target.value);
              setCandidateCount(null);
              setConfirmed(false);
            }}
            disabled={working || imageFields.length === 0}
          >
            <option value="all">All image fields</option>
            {imageFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>

        <div className="optimizer-form__row">
          <label>
            <span>Maximum dimension</span>
            <input
              type="number"
              min={320}
              max={6000}
              step={100}
              value={maxDimension}
              onChange={(event) => setMaxDimension(Number(event.target.value))}
              disabled={working}
            />
          </label>
          <label>
            <span>WebP quality</span>
            <input
              type="number"
              min={40}
              max={100}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
              disabled={working}
            />
          </label>
        </div>

        <label className="optimizer-checkbox">
          <input
            type="checkbox"
            checked={skipWebp}
            onChange={(event) => setSkipWebp(event.target.checked)}
            disabled={working}
          />
          <span>Skip images already stored as WebP</span>
        </label>

        <button
          className="btn btn--medium"
          onClick={() => void handleScan()}
          disabled={
            working || !selectedCollectionId || imageFields.length === 0
          }
        >
          {working ? "Working…" : "Scan images"}
        </button>

        {candidateCount !== null && candidateCount > 0 ? (
          <label className="optimizer-checkbox optimizer-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={working}
            />
            <span>
              Replace {candidateCount} CMS image reference
              {candidateCount === 1 ? "" : "s"} with optimized WebP uploads.
            </span>
          </label>
        ) : null}

        <button
          className="btn btn--primary btn--medium"
          onClick={() => void handleOptimize()}
          disabled={working || !confirmed || !candidateCount || !canUpdateItems}
        >
          {working ? "Optimizing…" : "Optimize and replace"}
        </button>
      </div>

      <pre className="report report--compact" aria-live="polite">
        {status}
      </pre>
    </section>
  );
}
