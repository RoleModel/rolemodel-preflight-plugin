import type {
  Collection,
  CollectionItem,
  Field,
  FrameNode,
  ImageAsset,
} from "@framer/plugin";

export interface AltTextFieldOption {
  id: string;
  name: string;
}

export interface AltTextCandidate {
  altText: string;
  contextLabel: string;
  existingAltText: string;
  fieldId?: string;
  generationError?: string;
  id: string;
  image: ImageAsset;
  item?: CollectionItem;
  locationLabel: string;
  node?: FrameNode;
  seoTitle: string;
  source: "canvas" | "cms";
}

interface AnthropicMessageResponse {
  content?: {
    text?: string;
    type?: string;
  }[];
  error?: {
    message?: string;
  };
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export const getCmsImageFields = (
  fields: readonly Field[]
): AltTextFieldOption[] =>
  fields
    .filter((field) => field.type === "image")
    .map((field) => ({ id: field.id, name: field.name }));

export const getCmsTextFields = (
  fields: readonly Field[]
): AltTextFieldOption[] =>
  fields
    .filter((field) => field.type === "string")
    .map((field) => ({ id: field.id, name: field.name }));

export const findPreferredSeoTitleFieldId = (
  fields: readonly AltTextFieldOption[]
): string =>
  fields.find((field) => /^seo[\s_-]*title$/iu.test(field.name))?.id ??
  fields.find((field) => /^title$/iu.test(field.name))?.id ??
  fields[0]?.id ??
  "";

const textFieldValue = (item: CollectionItem, fieldId: string): string => {
  const entry = item.fieldData[fieldId];
  return entry?.type === "string" ? entry.value.trim() : "";
};

export const collectAltTextCandidates = async (
  collection: Collection,
  imageFieldId: string,
  titleFieldId: string,
  includeExisting: boolean
): Promise<AltTextCandidate[]> => {
  const [fields, items] = await Promise.all([
    collection.getFields(),
    collection.getItems(),
  ]);
  const imageFields = getCmsImageFields(fields).filter(
    (field) => imageFieldId === "all" || field.id === imageFieldId
  );
  const candidates: AltTextCandidate[] = [];

  for (const item of items) {
    const seoTitle = textFieldValue(item, titleFieldId) || item.slug;
    for (const field of imageFields) {
      const entry = item.fieldData[field.id];
      if (entry?.type !== "image" || !entry.value) {
        continue;
      }
      const existingAltText = entry.value.altText?.trim() ?? "";
      if (existingAltText && !includeExisting) {
        continue;
      }
      candidates.push({
        altText: seoTitle,
        contextLabel: item.slug,
        existingAltText,
        fieldId: field.id,
        id: `${item.id}:${field.id}`,
        image: entry.value,
        item,
        locationLabel: field.name,
        seoTitle,
        source: "cms",
      });
    }
  }

  return candidates;
};

export const collectCanvasAltTextCandidates = (
  nodes: readonly FrameNode[],
  includeExisting: boolean
): AltTextCandidate[] => {
  const candidatesBySourceLayer = new Map<string, AltTextCandidate>();

  for (const node of nodes) {
    const image = node.backgroundImage;
    if (!image) {
      continue;
    }
    const existingAltText = image.altText?.trim() ?? "";
    if (existingAltText && !includeExisting) {
      continue;
    }
    const layerName = node.name?.trim() || "Canvas image";
    const sourceLayerId = node.originalId ?? node.id;
    const existing = candidatesBySourceLayer.get(sourceLayerId);
    if (existing && (!existing.node?.isReplica || node.isReplica)) {
      continue;
    }
    candidatesBySourceLayer.set(sourceLayerId, {
      altText: layerName,
      contextLabel: layerName,
      existingAltText,
      id: `canvas:${sourceLayerId}`,
      image,
      locationLabel: node.isReplica ? "Component source layer" : "Canvas layer",
      node,
      seoTitle: layerName,
      source: "canvas",
    });
  }

  return [...candidatesBySourceLayer.values()];
};

const cleanGeneratedAltText = (value: string): string =>
  value
    .trim()
    .replaceAll(/^["']|["']$/gu, "")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 160);

class AnthropicRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "AnthropicRequestError";
    this.retryable = retryable;
  }
}

const waitForRetry = (delayMs: number): Promise<void> =>
  // setTimeout has no promise-returning equivalent.
  // oxlint-disable-next-line promise/avoid-new -- see comment above
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const requestAltTextFromClaude = async ({
  apiKey,
  candidate,
  model,
}: {
  apiKey: string;
  candidate: AltTextCandidate;
  model: string;
}): Promise<string> => {
  const contextType =
    candidate.source === "cms" ? "CMS title" : "canvas layer name";
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    body: JSON.stringify({
      max_tokens: 100,
      messages: [
        {
          content: [
            {
              source: {
                type: "url",
                url: candidate.image.url,
              },
              type: "image",
            },
            {
              text: `Write concise, accurate SEO alt text for this image. Use the ${contextType} "${candidate.seoTitle}" only as context. Describe what is visibly important, do not keyword-stuff, do not begin with "image of" or "photo of", and return only the alt text. Keep it under 125 characters.`,
              type: "text",
            },
          ],
          role: "user",
        },
      ],
      model,
    }),
    headers: {
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey.trim(),
    },
    method: "POST",
  });
  const payload = (await response.json()) as AnthropicMessageResponse;
  if (!response.ok) {
    const retryable =
      response.status === 429 ||
      response.status === 529 ||
      response.status >= 500;
    throw new AnthropicRequestError(
      payload.error?.message ?? `Anthropic API returned ${response.status}.`,
      retryable
    );
  }
  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new AnthropicRequestError(
      "Claude did not return alt text for this image.",
      false
    );
  }
  return cleanGeneratedAltText(text);
};

export const generateAltTextWithClaude = async ({
  apiKey,
  candidate,
  model = DEFAULT_MODEL,
}: {
  apiKey: string;
  candidate: AltTextCandidate;
  model?: string;
}): Promise<string> => {
  const maximumAttempts = 3;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      // Each retry must wait for the previous request result.
      // oxlint-disable-next-line no-await-in-loop -- see comment above
      return await requestAltTextFromClaude({ apiKey, candidate, model });
    } catch (error) {
      const shouldRetry =
        error instanceof AnthropicRequestError &&
        error.retryable &&
        attempt < maximumAttempts - 1;
      if (!shouldRetry) {
        throw error;
      }
      // A short exponential delay handles burst rate limits without stalling
      // the full batch indefinitely.
      // oxlint-disable-next-line no-await-in-loop -- see comment above
      await waitForRetry(1500 * 2 ** attempt);
    }
  }
  throw new Error("Claude alt text generation exhausted its retries.");
};

export const applyCandidateAltText = async (
  candidate: AltTextCandidate
): Promise<void> => {
  if (candidate.source === "canvas" && candidate.node) {
    await candidate.node.setAttributes({
      backgroundImage: candidate.image.cloneWithAttributes({
        altText: candidate.altText.trim(),
      }),
    });
    return;
  }
  if (!candidate.item || !candidate.fieldId) {
    throw new Error("This CMS image is no longer available.");
  }
  await candidate.item.setAttributes({
    fieldData: {
      [candidate.fieldId]: {
        alt: candidate.altText.trim(),
        type: "image",
        value: candidate.image.url,
      },
    },
  });
};
