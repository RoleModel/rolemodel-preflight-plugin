export interface QueryParam {
  key: string;
  value: string;
}

const encodeUrlValue = (value: string): string =>
  encodeURIComponent(value).replaceAll("'", "%27");

const parseQueryString = (query: string): QueryParam[] => {
  if (!query) {
    return [];
  }

  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) {
        return { key: decodeURIComponent(pair), value: "" };
      }
      const key = decodeURIComponent(pair.slice(0, eqIndex));
      const value = decodeURIComponent(
        pair.slice(eqIndex + 1).replaceAll("+", " ")
      );
      return { key, value };
    });
};

export interface ParsedUrl {
  baseUrl: string;
  params: QueryParam[];
}

/** Splits a URL into its base path and decoded query params, for loading an existing link into the builder. */
export const parseUrl = (url: string): ParsedUrl => {
  const trimmed = url.trim();
  const queryIndex = trimmed.indexOf("?");
  if (queryIndex === -1) {
    return { baseUrl: trimmed, params: [] };
  }
  return {
    baseUrl: trimmed.slice(0, queryIndex),
    params: parseQueryString(trimmed.slice(queryIndex + 1)),
  };
};

/**
 * Builds a URL from a base path/URL and a list of key/value params, each
 * value percent-encoded consistently (spaces as %20, apostrophes as %27)
 * regardless of what punctuation it contains. Params with a blank key are
 * skipped. If the base URL already has its own query string, those params
 * are kept and overridden by any param sharing the same key.
 */
export const buildQueryUrl = (
  baseUrl: string,
  params: QueryParam[]
): string => {
  const { baseUrl: path, params: existingParams } = parseUrl(baseUrl);

  const merged: QueryParam[] = [...existingParams];
  for (const param of params) {
    const key = param.key.trim();
    if (!key) {
      continue;
    }
    const existingIndex = merged.findIndex((p) => p.key === key);
    if (existingIndex === -1) {
      merged.push({ key, value: param.value });
    } else {
      merged[existingIndex] = { key, value: param.value };
    }
  }

  if (merged.length === 0) {
    return path;
  }

  const query = merged
    .map((p) => `${encodeUrlValue(p.key)}=${encodeUrlValue(p.value)}`)
    .join("&");
  return `${path}?${query}`;
};
