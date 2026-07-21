import type {
  Collection,
  CollectionItem,
  Field,
  ImageAsset,
} from "@framer/plugin";
import { framer } from "@framer/plugin";

export interface ImageFieldOption {
  id: string;
  name: string;
}

export interface ImageCandidate {
  fieldId: string;
  fieldName: string;
  image: ImageAsset;
  item: CollectionItem;
}

export interface ImageOptimizationOptions {
  maxDimension: number;
  quality: number;
  skipWebp: boolean;
}

export interface ImageOptimizationResult {
  afterBytes: number;
  beforeBytes: number;
  skipped: boolean;
}

const WEBP_MIME_TYPE = "image/webp";
const SUPPORTED_SOURCE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  WEBP_MIME_TYPE,
]);

export const getImageFields = (fields: readonly Field[]): ImageFieldOption[] =>
  fields
    .filter((field) => field.type === "image")
    .map((field) => ({ id: field.id, name: field.name }));

export const collectImageCandidates = async (
  collection: Collection,
  selectedFieldId: string
): Promise<ImageCandidate[]> => {
  const [fields, items] = await Promise.all([
    collection.getFields(),
    collection.getItems(),
  ]);
  const imageFields = getImageFields(fields).filter(
    (field) => selectedFieldId === "all" || field.id === selectedFieldId
  );
  const candidates: ImageCandidate[] = [];

  for (const item of items) {
    for (const field of imageFields) {
      const entry = item.fieldData[field.id];
      if (entry?.type !== "image" || !entry.value) {
        continue;
      }
      candidates.push({
        fieldId: field.id,
        fieldName: field.name,
        image: entry.value,
        item,
      });
    }
  }

  return candidates;
};

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> =>
  // canvas.toBlob is a callback-only API with no promise-returning equivalent.
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("The browser could not encode this image as WebP."));
      },
      WEBP_MIME_TYPE,
      quality
    );
  });

const optimizedDimensions = (
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } => {
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return { height, width };
  }
  const scale = maxDimension / longestSide;
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
};

const optimizedFileName = (candidate: ImageCandidate): string => {
  const baseName = candidate.item.slug || candidate.image.id || "cms-image";
  const fieldName = candidate.fieldName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return `${baseName}-${fieldName || "image"}.webp`;
};

export const optimizeCmsImage = async (
  candidate: ImageCandidate,
  options: ImageOptimizationOptions
): Promise<ImageOptimizationResult> => {
  const source = await candidate.image.getData();
  const beforeBytes = source.bytes.byteLength;
  if (options.skipWebp && source.mimeType === WEBP_MIME_TYPE) {
    return { afterBytes: beforeBytes, beforeBytes, skipped: true };
  }
  if (!SUPPORTED_SOURCE_TYPES.has(source.mimeType)) {
    return { afterBytes: beforeBytes, beforeBytes, skipped: true };
  }

  const sourceBlob = new Blob([source.bytes], { type: source.mimeType });
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const size = optimizedDimensions(
      bitmap.width,
      bitmap.height,
      options.maxDimension
    );
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      throw new Error("The browser could not create a 2D image context.");
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    const optimizedBlob = await canvasToBlob(canvas, options.quality);
    const file = new File([optimizedBlob], optimizedFileName(candidate), {
      type: WEBP_MIME_TYPE,
    });
    const uploaded = await framer.uploadImage(file);
    await candidate.item.setAttributes({
      fieldData: {
        [candidate.fieldId]: {
          alt: candidate.image.altText ?? "",
          type: "image",
          value: uploaded.url,
        },
      },
    });

    return {
      afterBytes: optimizedBlob.size,
      beforeBytes,
      skipped: false,
    };
  } finally {
    bitmap.close();
  }
};
