const ANTHROPIC_API_KEY_STORAGE_KEY = "rolemodel-preflight:anthropic-api-key";

const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readStoredAnthropicApiKey = (
  storage: Storage | null = browserStorage()
): string => {
  try {
    return storage?.getItem(ANTHROPIC_API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

export const saveAnthropicApiKey = (
  apiKey: string,
  storage: Storage | null = browserStorage()
): boolean => {
  try {
    if (!storage) {
      return false;
    }
    storage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, apiKey);
    return true;
  } catch {
    return false;
  }
};

export const clearStoredAnthropicApiKey = (
  storage: Storage | null = browserStorage()
): boolean => {
  try {
    if (!storage) {
      return false;
    }
    storage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};
