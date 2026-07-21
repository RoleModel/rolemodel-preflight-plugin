export type BatchRenameMode = "findReplace" | "addText" | "format";

export interface FindReplaceOptions {
  find: string;
  replace: string;
  matchCase: boolean;
}

export interface AddTextOptions {
  text: string;
  placement: "before" | "after";
}

export interface FormatOptions {
  baseName: string;
  placement: "prefix" | "suffix";
  startNumber: number;
  padding: number;
  separator: string;
}

export interface BatchRenameItem {
  id: string;
  name: string;
}

export interface BatchRenamePlanEntry {
  id: string;
  before: string;
  after: string;
  changed: boolean;
}

const planFindReplace = (
  items: BatchRenameItem[],
  options: FindReplaceOptions
): BatchRenamePlanEntry[] => {
  const { find, replace, matchCase } = options;
  if (!find) {
    return items.map((item) => ({
      after: item.name,
      before: item.name,
      changed: false,
      id: item.id,
    }));
  }

  const flags = matchCase ? "gu" : "giu";
  const pattern = new RegExp(
    find.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    flags
  );

  return items.map((item) => {
    const after = item.name.replaceAll(pattern, replace);
    return {
      after,
      before: item.name,
      changed: after !== item.name,
      id: item.id,
    };
  });
};

const planAddText = (
  items: BatchRenameItem[],
  options: AddTextOptions
): BatchRenamePlanEntry[] =>
  items.map((item) => {
    const after =
      options.placement === "before"
        ? `${options.text}${item.name}`
        : `${item.name}${options.text}`;
    return {
      after,
      before: item.name,
      changed: after !== item.name,
      id: item.id,
    };
  });

const planFormat = (
  items: BatchRenameItem[],
  options: FormatOptions
): BatchRenamePlanEntry[] =>
  items.map((item, index) => {
    const number = String(options.startNumber + index).padStart(
      options.padding,
      "0"
    );
    const after =
      options.placement === "prefix"
        ? `${number}${options.separator}${options.baseName}`
        : `${options.baseName}${options.separator}${number}`;
    return {
      after,
      before: item.name,
      changed: after !== item.name,
      id: item.id,
    };
  });

export const computeBatchRenamePlan = (
  items: BatchRenameItem[],
  mode: BatchRenameMode,
  options: FindReplaceOptions | AddTextOptions | FormatOptions
): BatchRenamePlanEntry[] => {
  if (mode === "findReplace") {
    return planFindReplace(items, options as FindReplaceOptions);
  }
  if (mode === "addText") {
    return planAddText(items, options as AddTextOptions);
  }
  return planFormat(items, options as FormatOptions);
};

export const DEFAULT_FIND_REPLACE_OPTIONS: FindReplaceOptions = {
  find: "",
  matchCase: false,
  replace: "",
};

export const DEFAULT_ADD_TEXT_OPTIONS: AddTextOptions = {
  placement: "after",
  text: "",
};

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  baseName: "",
  padding: 1,
  placement: "suffix",
  separator: " ",
  startNumber: 1,
};
