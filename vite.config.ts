import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const __dirname = import.meta.dirname;
const httpsCertPath =
  process.env.FRAMER_PLUGIN_CERT ?? "/tmp/framer-plugin-localhost-cert.pem";
const httpsKeyPath =
  process.env.FRAMER_PLUGIN_KEY ?? "/tmp/framer-plugin-localhost-key.pem";
const repoRoot = path.resolve(__dirname, "..");
const framerComponentUrlsPath = path.resolve(
  repoRoot,
  "framer-component-urls.json"
);
const framerProjectComponentsPath = path.resolve(
  repoRoot,
  "framer-project-components.json"
);
const componentManifestPath = path.resolve(
  repoRoot,
  "public",
  "component-manifest.json"
);
const framerSyncRoot = path.resolve(repoRoot, "framer-sync", "RoleModel");
const componentOverridesPath = path.resolve(
  repoRoot,
  "component-overrides.json"
);
const repoScanRoots = [
  path.resolve(repoRoot, "src"),
  path.resolve(repoRoot, "@framer/plugin", "src"),
  path.resolve(repoRoot, "README.md"),
  path.resolve(repoRoot, "vite.config.ts"),
  path.resolve(repoRoot, "src", "tests"),
];

const execFileAsync = promisify(execFile);

const normalizePathKey = (value: string) =>
  String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "");

const getHttpsServerOptions = () => {
  if (!fs.existsSync(httpsCertPath) || !fs.existsSync(httpsKeyPath)) {
    fs.mkdirSync(path.dirname(httpsCertPath), { recursive: true });
    fs.mkdirSync(path.dirname(httpsKeyPath), { recursive: true });
    try {
      execFileSync(
        "mkcert",
        [
          "-cert-file",
          httpsCertPath,
          "-key-file",
          httpsKeyPath,
          "localhost",
          "127.0.0.1",
          "::1",
        ],
        { stdio: "ignore" }
      );
    } catch {
      // fall through to openssl fallback
    }
  }

  if (!fs.existsSync(httpsCertPath) || !fs.existsSync(httpsKeyPath)) {
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-days",
          "365",
          "-nodes",
          "-keyout",
          httpsKeyPath,
          "-out",
          httpsCertPath,
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
        ],
        { stdio: "ignore" }
      );
    } catch {
      // fall through to the existence check below
    }
  }

  if (!fs.existsSync(httpsCertPath) || !fs.existsSync(httpsKeyPath)) {
    // `https: true` would start a TLS server with no certificate, and every
    // client would fail with ERR_SSL_VERSION_OR_CIPHER_MISMATCH. Fail loudly
    // instead so the missing cert is fixable.
    throw new Error(
      `Could not generate a localhost TLS certificate at ${httpsCertPath}. ` +
        "Install mkcert (brew install mkcert && mkcert -install) or openssl, " +
        "or point FRAMER_PLUGIN_CERT / FRAMER_PLUGIN_KEY at an existing cert pair."
    );
  }

  return {
    cert: fs.readFileSync(httpsCertPath),
    key: fs.readFileSync(httpsKeyPath),
  };
};

const normalizeName = (value: string): string =>
  value.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

const normalizeUrlCandidate = (value: unknown): string | null => {
  const next = String(value ?? "").trim();
  if (!next) {
    return null;
  }
  if (
    !next.startsWith("https://framer.com/m/") &&
    !next.startsWith("https://framerusercontent.com/modules/")
  ) {
    return null;
  }
  return next;
};

const urlSlug = (url: string): string =>
  url
    .split("/")
    .pop()
    ?.replace(/\.js.*$/u, "") ?? "";

const scoreUrlForComponentKey = (componentKey: string, url: string): number => {
  const normalizedKey = normalizeName(componentKey);
  const normalizedSlug = normalizeName(urlSlug(url));
  let score = 0;

  if (normalizedSlug === normalizedKey) {
    score += 120;
  } else if (normalizedSlug.startsWith(normalizedKey)) {
    score += 80;
  } else if (normalizedSlug.includes(normalizedKey)) {
    score += 40;
  }

  if (url.includes("@")) {
    score += 20;
  }
  if (url.includes("#")) {
    score -= 1000;
  }

  return score;
};

const selectPreferredUrlForComponentKey = (
  componentKey: string,
  urls: unknown[]
): string | null => {
  const deduped = [
    ...new Set(
      (Array.isArray(urls) ? urls : [])
        .map(normalizeUrlCandidate)
        .filter((url): url is string => Boolean(url))
    ),
  ];

  if (deduped.length === 0) {
    return null;
  }
  if (deduped.length === 1) {
    return deduped[0] ?? null;
  }

  const ranked = deduped
    .map((url, index) => ({
      index,
      score: scoreUrlForComponentKey(componentKey, url),
      url,
    }))
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    });

  return ranked[0]?.url ?? deduped.at(-1) ?? null;
};

const normalizeComponentUrlsMap = (
  componentUrls: Record<string, string[]>
): Record<string, string[]> => {
  const next: Record<string, string[]> = {};

  for (const [componentKey, urls] of Object.entries(componentUrls ?? {})) {
    const preferred = selectPreferredUrlForComponentKey(componentKey, urls);
    if (!preferred) {
      continue;
    }
    next[componentKey] = [preferred];
  }

  return next;
};

const collectTextFiles = (entryPath: string, acc: string[] = []): string[] => {
  if (!fs.existsSync(entryPath)) {
    return acc;
  }

  const stat = fs.statSync(entryPath);
  if (stat.isFile()) {
    acc.push(entryPath);
    return acc;
  }

  for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (
      child.name === "node_modules" ||
      child.name === ".git" ||
      child.name === "cosmos-export" ||
      child.name === "public"
    ) {
      continue;
    }
    collectTextFiles(path.join(entryPath, child.name), acc);
  }

  return acc;
};

const discoverComponentUrls = (
  componentKey: string,
  displayName?: string
): string[] => {
  const pathCandidates = [componentKey, displayName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"));

  const targetNames = new Set(
    [componentKey, displayName]
      .filter((value): value is string => Boolean(value))
      .map(normalizeName)
  );

  const discovered = new Set<string>();
  const files = repoScanRoots.flatMap((entry) => collectTextFiles(entry));
  const urlRegex = /https:\/\/framer\.com\/m\/[^"'`\s)]+/gu;
  const importRegex =
    /import\s+(?<importedName>[A-Za-z0-9_$]+)\s+from\s+["'](?<url>https:\/\/framer\.com\/m\/[^"']+)["']/gu;

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf-8");

    for (const match of source.matchAll(importRegex)) {
      const importedName = normalizeName(match.groups?.importedName ?? "");
      const url = match.groups?.url;
      if (url && targetNames.has(importedName)) {
        discovered.add(url);
      }
    }

    for (const url of source.match(urlRegex) ?? []) {
      const escapedUrl = url.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const localPathRegex = new RegExp(
        `${escapedUrl}["']\\s*:\\s*["'][^"']*\\/(${pathCandidates.join("|")})["']`,
        "iu"
      );
      const slug =
        url
          .split("/")
          .pop()
          ?.replace(/\.js.*$/u, "") ?? "";
      const normalizedSlug = normalizeName(slug);

      if (
        localPathRegex.test(source) ||
        [...targetNames].some((name) => normalizedSlug.includes(name))
      ) {
        discovered.add(url);
      }
    }
  }

  return [...discovered];
};

const writeFramerComponentUrls = (componentUrls: Record<string, string[]>) => {
  fs.writeFileSync(
    framerComponentUrlsPath,
    `${JSON.stringify(componentUrls, null, 2)}\n`
  );
};

const readFramerComponentUrls = (): Record<string, string[]> => {
  if (!fs.existsSync(framerComponentUrlsPath)) {
    return {};
  }

  const raw = JSON.parse(
    fs.readFileSync(framerComponentUrlsPath, "utf-8")
  ) as Record<string, string[]>;
  const normalized = normalizeComponentUrlsMap(raw);

  if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
    writeFramerComponentUrls(normalized);
  }

  return normalized;
};

const latestKnownFramerUrl = (componentKey: string): string | null => {
  const urls = readFramerComponentUrls()[componentKey] ?? [];
  return urls.length > 0 ? (urls.at(-1) ?? null) : null;
};

const readFramerProjectComponents = (): Record<
  string,
  {
    key: string;
    displayName: string;
    category: string;
    description: string;
    status: "stable" | "beta" | "deprecated";
    tags: string[];
    isCanvas: boolean;
    framerUrl?: string;
    propCount: number;
    source: "framer-project";
    path?: string;
    syncPath?: string;
  }
> => {
  if (!fs.existsSync(framerProjectComponentsPath)) {
    return {};
  }
  return JSON.parse(
    fs.readFileSync(framerProjectComponentsPath, "utf-8")
  ) as Record<
    string,
    {
      key: string;
      displayName: string;
      category: string;
      description: string;
      status: "stable" | "beta" | "deprecated";
      tags: string[];
      isCanvas: boolean;
      framerUrl?: string;
      propCount: number;
      source: "framer-project";
      path?: string;
    }
  >;
};

const writeFramerProjectComponents = (
  components: Record<
    string,
    {
      key: string;
      displayName: string;
      category: string;
      description: string;
      status: "stable" | "beta" | "deprecated";
      tags: string[];
      isCanvas: boolean;
      framerUrl?: string;
      propCount: number;
      source: "framer-project";
      path?: string;
      syncPath?: string;
    }
  >
) => {
  fs.writeFileSync(
    framerProjectComponentsPath,
    `${JSON.stringify(components, null, 2)}\n`
  );
};

const stripJsonComments = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const normalizeIdentifier = (value: string): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "");

const readManifestCanvasMap = (): Map<string, boolean> => {
  if (!fs.existsSync(componentManifestPath)) {
    return new Map();
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(componentManifestPath, "utf-8")
    ) as {
      components?: Record<
        string,
        { key?: string; displayName?: string; isCanvas?: boolean }
      >;
    };

    const map = new Map<string, boolean>();
    for (const component of Object.values(manifest.components ?? {})) {
      const value = Boolean(component?.isCanvas);
      const keyToken = normalizeIdentifier(String(component?.key ?? ""));
      const nameToken = normalizeIdentifier(
        String(component?.displayName ?? "")
      );
      if (keyToken) {
        map.set(keyToken, value);
      }
      if (nameToken) {
        map.set(nameToken, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
};

const readComponentOverrides = (): Record<string, Record<string, unknown>> => {
  if (!fs.existsSync(componentOverridesPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(componentOverridesPath, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
};

const writeComponentOverrides = (
  overrides: Record<string, Record<string, unknown>>
) => {
  fs.writeFileSync(
    componentOverridesPath,
    `${JSON.stringify(overrides, null, 2)}\n`
  );
};

const listFilesRecursive = (rootPath: string, acc: string[] = []): string[] => {
  if (!fs.existsSync(rootPath)) {
    return acc;
  }

  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(nextPath, acc);
      continue;
    }
    acc.push(nextPath);
  }

  return acc;
};

const inlinedTeamDataSource = `const teamData = [
    {
        name: "Caleb Woods",
        role: "CEO",
        image: "https://avatars.slack-edge.com/2023-09-19/5919251021764_69cd2187061a7a15f211_48.png",
        bio: "Caleb is the CEO of the company. He is a software engineer and a startup founder.",
    },
    {
        name: "Tim Irwin",
        role: "Craftsman Director",
        image: "https://avatars.slack-edge.com/2022-10-26/4275062737397_d4ecb909c9b12f12f9fc_48.jpg",
        bio: "Tim is the Craftsman Director of the company. He is a software engineer and a startup founder.",
    },
    {
        name: "Mark Kraemer ",
        role: "Engineering Manager",
        image: "https://avatars.slack-edge.com/2022-12-09/4520971711312_16bf1267be0d3abfdb2d_48.jpg",
        bio: "Mark is the Engineering Manager of the company. He is a software engineer and a startup founder.",
    },
]`;

const inlinedCreateStoreSource = `type Listener = () => void

interface Store<T extends object> {
    getState: () => T
    setState: (partial: Partial<T> | ((prev: T) => Partial<T>)) => void
    subscribe: (listener: Listener) => () => void
}

function createStoreInternal<T extends object>(initialState: T): Store<T> {
    let state = { ...initialState }
    const listeners = new Set<Listener>()

    const getState = () => state

    const setState = (partial: Partial<T> | ((prev: T) => Partial<T>)) => {
        const nextPartial =
            typeof partial === "function" ? partial(state) : partial
        state = { ...state, ...nextPartial }
        listeners.forEach(listener => listener())
    }

    const subscribe = (listener: Listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
    }

    return { getState, setState, subscribe }
}

const storeCache = new Map<string, Store<any>>()

function createStore<T extends object>(
    initialState: T
): () => [T, (partial: Partial<T> | ((prev: T) => Partial<T>)) => void] {
    const storeKey = JSON.stringify(Object.keys(initialState).sort())

    let store = storeCache.get(storeKey) as Store<T> | undefined
    if (!store) {
        store = createStoreInternal(initialState)
        storeCache.set(storeKey, store)
    }

    return function useStore(): [
        T,
        (partial: Partial<T> | ((prev: T) => Partial<T>)) => void,
    ] {
        const state = useSyncExternalStore(
            store!.subscribe,
            store!.getState,
            store!.getState
        )

        const setState = useCallback(
            (partial: Partial<T> | ((prev: T) => Partial<T>)) => {
                store!.setState(partial)
            },
            []
        )

        return [state, setState]
    }
}`;

const inlineFramerSyncSupportModules = (content: string): string => {
  let next = content;

  next = next.replaceAll(
    /import\s+\{\s*createStore\s*\}\s+from\s+["']\.\.\/_support\/framer-store["'];?\n?/gu,
    `${inlinedCreateStoreSource}\n\n`
  );

  next = next.replaceAll(
    /import\s+\{\s*teamData\s*\}\s+from\s+["']\.\.\/_support\/stubs\/TeamData["'];?\n?/gu,
    `${inlinedTeamDataSource}\n\n`
  );

  return next;
};

/**
 * Replaces `import Name from "../_support/stubs/X"` with the latest
 * published Framer CDN URL for that component.
 *
 * Card, DrawerContent, and Preview are Framer-published components — in Framer
 * they must be imported from their CDN URL, not from a local stub file.
 */
const replaceStubImportsWithFramerUrls = (content: string): string => {
  const STUB_TO_COMPONENT_KEY: Record<string, string> = {
    Card: "Card",
    DrawerContent: "DrawerContent",
    Preview: "Preview",
  };

  let next = content;
  for (const [stubName, componentKey] of Object.entries(
    STUB_TO_COMPONENT_KEY
  )) {
    const url = latestKnownFramerUrl(componentKey);
    if (!url) {
      continue;
    }

    next = next.replace(
      new RegExp(
        `import\\s+([A-Za-z0-9_$]+)\\s+from\\s+["']\\.\\.\\/_support\\/stubs\\/${stubName}["'];?\\n?`,
        "u"
      ),
      `import $1 from "${url}"\n`
    );
  }

  return next;
};

/**
 * Inlines the `_support/shapes.tsx` module directly into files that import from it.
 *
 * shapes.tsx is a pure utility module (SVG paths, device mockup components, brush
 * highlights) with no published Framer CDN URL.  Rather than leaving a relative
 * import that Framer can't resolve, we embed the module source inline — the same
 * technique used for framer-store and TeamData.
 */
const inlineSupportShapesModule = (content: string): string => {
  if (
    !content.includes('"../_support/shapes"') &&
    !content.includes("'../_support/shapes'")
  ) {
    return content;
  }

  const shapesPath = path.join(framerSyncRoot, "_support", "shapes.tsx");
  if (!fs.existsSync(shapesPath)) {
    return content;
  }

  let shapesSource = fs.readFileSync(shapesPath, "utf-8");
  // Drop the React import — the host file already imports React
  shapesSource = shapesSource.replace(
    /^import \* as React from ["']react["'];?\r?\n/mu,
    ""
  );
  // Drop the generated-file comment block so it doesn't appear twice
  shapesSource = shapesSource.replace(/^\/\*\*[\s\S]*?\*\/\n/mu, "");
  // Drop `export default shapePaths` — the host file has its own default export
  shapesSource = shapesSource.replace(/^export default \w+;?\r?\n?/mu, "");

  return content.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*["']\.\.\/_support\/shapes["'];?\s*/mu,
    `${shapesSource}\n\n`
  );
};

const inlinedCaseStudyCardCodeSource = `function CaseStudyCardCode({
    children,
    style,
    title = "Case Study",
    description = "Description placeholder",
    image,
    ...props
}) {
    const rootStyle = {
        padding: 16,
        borderRadius: 12,
        backgroundColor: "#1a1a1a",
        color: "#fff",
        ...style,
    }

    return (
        <div style={rootStyle} {...props}>
            {image ? (
                <img
                    src={image}
                    alt=""
                    style={{ width: "100%", borderRadius: 8, marginBottom: 12 }}
                />
            ) : null}
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>{title}</h3>
            <p style={{ margin: 0, opacity: 0.7, fontSize: 14 }}>{description}</p>
            {children}
        </div>
    )
}`;

const inlinedRemotePlaceholderSource = `function FramerRemotePlaceholder() {
    return null
}`;

const buildInlinedNavBarLogoSource = (): string => {
  const logoSourcePath = path.join(
    repoRoot,
    "src",
    "lib",
    "stubs",
    "Logo",
    "index.tsx"
  );
  const logoSource = fs.readFileSync(logoSourcePath, "utf-8");
  const svgMatch = logoSource.match(
    /export const SVG_MARKUP = String\.raw`(?<markup>[\s\S]*?)`/u
  );
  const svgMarkup = svgMatch?.groups?.markup ?? "";

  return `const SVG_MARKUP = String.raw\`${svgMarkup}\`

function Logo({
    width = 110,
    height = 44,
}) {
    return (
        <div
            style={{
                width,
                height,
                display: "grid",
                placeItems: "center",
                overflow: "hidden",
            }}
            dangerouslySetInnerHTML={{
                __html: SVG_MARKUP.replace(
                    "<svg ",
                    '<svg style="width:100%;height:100%;max-width:100%;max-height:100%;" '
                ),
            }}
        />
    )
}`;
};

const inlineNavBarSupportModules = (
  content: string,
  syncPath: string
): string => {
  if (syncPath !== "Navigation/NavBar.tsx") {
    return content;
  }

  let next = content;
  next = next.replace(
    /import\s+Logo,\s*\{\s*SVG_MARKUP\s*\}\s+from\s+["']\.\.\/_support\/stubs\/Logo["'];?\n?/u,
    `${buildInlinedNavBarLogoSource()}\n\n`
  );
  next = next.replace(
    /import\s+CaseStudyCardCode\s+from\s+["']\.\.\/_support\/stubs\/CaseStudyCardCode["'];?\n?/u,
    `${inlinedCaseStudyCardCodeSource}\n\n`
  );

  return next;
};

const tuneScrollJourneyForSync = (
  content: string,
  syncPath: string
): string => {
  if (syncPath !== "Scrolling/ScrollJourney.tsx") {
    return content;
  }

  let next = content;
  next = next.replace(/^"use client"\s*\n+/mu, "");
  next = next.replace(
    /import\s+\{\s*CSSPlugin\s*\}\s+from\s+["']gsap\/CSSPlugin["'];?\n?/u,
    ""
  );
  next = next.replace(
    /gsap\.registerPlugin\(CSSPlugin,\s*ScrollTrigger\)/u,
    "gsap.registerPlugin(ScrollTrigger)"
  );

  return next;
};

const rewriteCriticalRelativeImports = (content: string): string => {
  const buttonPillUrl = latestKnownFramerUrl("ButtonPill");
  const hugeIconUrl = latestKnownFramerUrl("HugeIconFont");

  let next = content;
  if (buttonPillUrl) {
    next = next.replaceAll(
      /from\s+["'](?:\.\.\/|\.\/)*Utility\/ButtonPill(?:\.tsx|\.ts|\.jsx|\.js)?["']/gu,
      `from "${buttonPillUrl}"`
    );
    next = next.replaceAll(
      /from\s+["'](?:\.\.\/|\.\/)*ButtonPill(?:\.tsx|\.ts|\.jsx|\.js)?["']/gu,
      `from "${buttonPillUrl}"`
    );
  }

  if (hugeIconUrl) {
    next = next.replaceAll(
      /from\s+["'](?:\.\.\/|\.\/)*Utility\/HugeIconFont(?:\.tsx|\.ts|\.jsx|\.js)?["']/gu,
      `from "${hugeIconUrl}"`
    );
    next = next.replaceAll(
      /from\s+["'](?:\.\.\/|\.\/)*HugeIconFont(?:\.tsx|\.ts|\.jsx|\.js)?["']/gu,
      `from "${hugeIconUrl}"`
    );
  }

  return next;
};

const wrapProblematicSyncComponents = (
  content: string,
  syncPath: string
): string => {
  const wrapperConfig: Record<
    string,
    { componentKey: string; exportName: string }
  > = {
    // Heavy components that frequently trigger waitForComponentLoader timeout.
    "Media/iPadDevice.tsx": {
      componentKey: "iPadDevice",
      exportName: "RemoteiPadDevice",
    },
    "Utility/HugeIconFont.tsx": {
      componentKey: "HugeIconFont",
      exportName: "RemoteHugeIconFont",
    },
    "Utility/iPadDevice.tsx": {
      componentKey: "iPadDevice",
      exportName: "RemoteiPadDevice",
    },
  };

  const config = wrapperConfig[syncPath];
  if (!config) {
    return content;
  }

  const remoteUrl = latestKnownFramerUrl(config.componentKey);
  if (!remoteUrl) {
    return content;
  }

  return `/**
 * Framer Code Sync wrapper for ${config.componentKey}.
 * Uses published CDN module to avoid loader timeouts during code-file sync.
 */
import ${config.exportName} from "${remoteUrl}"

export default ${config.exportName}
`;
};

const rewriteSoftwareThatFits3DTrayImports = (
  content: string,
  syncPath: string
): string => {
  if (syncPath !== "3D/SoftwareThatFits3DTray.tsx") {
    return content;
  }

  return content.replaceAll(
    /from\s+["']@react-three\/fiber["']/gu,
    `from "https://esm.sh/@react-three/fiber@8.18.0?external=react,react-dom,three"`
  );
};

const resolveRelativeReExport = (content: string, filePath: string): string => {
  const match = content.match(
    /^\s*export\s+\{\s*default\s*\}\s+from\s+["'](?<path>\.\.?\/[^"']+)["']\s*;?\s*[\r\n]+\s*export\s+\*\s+from\s+["']\k<path>["']\s*;?\s*$/mu
  );
  if (!match?.groups?.path) {
    return content;
  }

  const targetPath = path.resolve(
    path.dirname(filePath),
    `${match.groups.path}.tsx`
  );
  if (!fs.existsSync(targetPath)) {
    return content;
  }

  return fs.readFileSync(targetPath, "utf-8");
};

const readDirectSyncFiles = () => {
  const configPath = path.join(framerSyncRoot, "framer-code-sync.config.jsonc");
  const configSource = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(stripJsonComments(configSource)) as {
    importReplacements?: { find: string; replace: string }[];
    uploadPathOverrides?: Record<string, string>;
  };
  const replacements = config.importReplacements ?? [];
  const uploadPathOverrides = config.uploadPathOverrides ?? {};

  return listFilesRecursive(framerSyncRoot)
    .filter((filePath) => filePath.endsWith(".tsx"))
    .map((filePath) => {
      const syncPath = path
        .relative(framerSyncRoot, filePath)
        .replaceAll("\\", "/");
      // Exclude entire _support folder — its modules are either inlined
      // into their consumers or replaced with Framer CDN URL imports.
      if (syncPath.startsWith("_support/")) {
        return null;
      }
      let content = fs.readFileSync(filePath, "utf-8");
      content = resolveRelativeReExport(content, filePath);
      for (const replacement of replacements) {
        content = content.replaceAll(
          `"${replacement.find}"`,
          `"${replacement.replace}"`
        );
        content = content.replaceAll(
          `'${replacement.find}'`,
          `'${replacement.replace}'`
        );
      }
      content = inlineFramerSyncSupportModules(content);
      content = replaceStubImportsWithFramerUrls(content);
      content = inlineSupportShapesModule(content);
      content = content.replace(
        /import\s+(?<localName>[A-Za-z0-9_]+)\s+from\s+["']\.\.\/_support\/stubs\/FramerRemotePlaceholder["'];?\n?/u,
        `${inlinedRemotePlaceholderSource}\n\nconst $<localName> = FramerRemotePlaceholder\n\n`
      );
      content = inlineNavBarSupportModules(content, syncPath);
      content = tuneScrollJourneyForSync(content, syncPath);
      content = rewriteCriticalRelativeImports(content);
      content = rewriteSoftwareThatFits3DTrayImports(content, syncPath);
      content = wrapProblematicSyncComponents(content, syncPath);

      const normalizedSyncPath = normalizePathKey(syncPath);
      const uploadPath =
        uploadPathOverrides[normalizedSyncPath] ??
        uploadPathOverrides[syncPath] ??
        undefined;

      return {
        content,
        path: path.relative(repoRoot, filePath).replaceAll("\\", "/"),
        syncPath,
        uploadPath,
      };
    })
    .filter(Boolean);
};

const mergeComponentUrls = (
  existingUrls: Record<string, string[]>,
  incomingMappings: Record<string, string[]>
): Record<string, string[]> => {
  const next = { ...existingUrls };

  for (const [componentKey, urls] of Object.entries(incomingMappings)) {
    const preferred = selectPreferredUrlForComponentKey(componentKey, urls);
    if (!preferred) {
      continue;
    }
    next[componentKey] = [preferred];
  }

  return normalizeComponentUrlsMap(next);
};

const runRepoScript = async (scriptName: string): Promise<void> => {
  await execFileAsync("node", [path.resolve(repoRoot, "scripts", scriptName)], {
    cwd: repoRoot,
  });
};

const runGenerateManifest = (): Promise<void> =>
  runRepoScript("generate-manifest.mjs");

const requestMethod = (req: unknown): string => {
  const candidate = req as {
    method?: unknown;
    headers?: Record<string, unknown>;
  };
  const { method: candidateMethod } = candidate;

  let method: string;
  if (typeof candidateMethod === "string") {
    method = candidateMethod;
  } else if (typeof candidate?.headers?.[":method"] === "string") {
    method = candidate.headers[":method"] as string;
  } else {
    method = "";
  }

  return method.toUpperCase();
};

const runGenerateSyncArtifacts = async () => {
  await runRepoScript("generate-manifest.mjs");
  await runRepoScript("generate-framer-registry.mjs");
  await runRepoScript("generate-framer-sync.mjs");
};

const replaceFramerProjectComponents = (
  incoming: Record<
    string,
    {
      key: string;
      displayName: string;
      category: string;
      description: string;
      status: "stable" | "beta" | "deprecated";
      tags: string[];
      isCanvas: boolean;
      framerUrl?: string;
      propCount: number;
      source: "framer-project";
      path?: string;
      syncPath?: string;
    }
  >
) => {
  const manifestCanvasMap = readManifestCanvasMap();
  const next = Object.fromEntries(
    Object.entries(incoming).map(([key, component]) => {
      const keyToken = normalizeIdentifier(component.key || key);
      const nameToken = normalizeIdentifier(component.displayName || "");
      const catalogIsCanvas =
        manifestCanvasMap.get(keyToken) ?? manifestCanvasMap.get(nameToken);

      return [
        key,
        {
          ...component,
          isCanvas:
            typeof catalogIsCanvas === "boolean"
              ? catalogIsCanvas
              : component.isCanvas,
        },
      ];
    })
  );

  writeFramerProjectComponents(next);
  return next;
};

/**
 * Serves the repo-root manifest at /component-manifest.json in dev.
 * Avoids proxying Cosmos (port can shift if 5001 is taken) and works with only
 * `npm run generate:manifest` — Cosmos does not need to be running.
 */
const serveRepoManifest = (): Plugin => {
  const manifestPath = path.resolve(
    __dirname,
    "..",
    "public",
    "component-manifest.json"
  );
  return {
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url ? req.url.split("?")[0] : "";
        if (pathname !== "/component-manifest.json") {
          next();
          return;
        }
        void (async () => {
          try {
            const data = await fs.promises.readFile(manifestPath);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(data);
          } catch {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(
              "Missing ../public/component-manifest.json — from repo root run: npm run generate:manifest"
            );
          }
        })();
      });

      server.middlewares.use(
        "/__repo/component-overrides/import-cms-categories",
        (req, res, next) => {
          if (requestMethod(req) !== "POST") {
            next();
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const payload = body
                ? (JSON.parse(body) as {
                    entries?: { key?: string; category?: string }[];
                  })
                : {};
              const entries = Array.isArray(payload.entries)
                ? payload.entries
                : [];

              if (entries.length === 0) {
                res.statusCode = 400;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(
                  JSON.stringify({ error: "entries payload is required" })
                );
                return;
              }

              const overrides = readComponentOverrides();
              const keyIndex = new Map(
                Object.keys(overrides).map((key) => [
                  normalizeIdentifier(key),
                  key,
                ])
              );

              let updatedCount = 0;

              for (const entry of entries) {
                const rawKey = String(entry?.key ?? "").trim();
                const category = String(entry?.category ?? "").trim();
                if (!rawKey || !category) {
                  continue;
                }

                const normalizedKey = normalizeIdentifier(rawKey);
                const overrideKey = keyIndex.get(normalizedKey) ?? rawKey;
                const existing = overrides[overrideKey] ?? {};
                const previousCategory = String(existing.category ?? "").trim();

                if (previousCategory !== category) {
                  overrides[overrideKey] = {
                    ...existing,
                    category,
                  };
                  updatedCount += 1;
                } else if (!overrides[overrideKey]) {
                  overrides[overrideKey] = {
                    ...existing,
                    category,
                  };
                }
              }

              writeComponentOverrides(overrides);
              await runGenerateManifest();

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  ok: true,
                  receivedCount: entries.length,
                  updatedCount,
                })
              );
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          });
        }
      );

      server.middlewares.use(
        "/__repo/framer-component-urls",
        (req, res, next) => {
          if (requestMethod(req) === "GET") {
            try {
              const componentUrls = readFramerComponentUrls();
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify(componentUrls, null, 2));
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
            return;
          }

          if (requestMethod(req) !== "POST") {
            next();
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const { componentKey, url, urls, mappings } = JSON.parse(
                body
              ) as {
                componentKey?: string;
                url?: string;
                urls?: string[];
                mappings?: Record<string, string[]>;
              };

              if (mappings && typeof mappings === "object") {
                const componentUrls = readFramerComponentUrls();
                const nextUrls = mergeComponentUrls(componentUrls, mappings);
                writeFramerComponentUrls(nextUrls);
                await runGenerateManifest();

                res.statusCode = 200;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(
                  JSON.stringify({
                    mappings: nextUrls,
                    updatedKeys: Object.keys(mappings),
                  })
                );
                return;
              }

              const incomingUrls = [
                ...(Array.isArray(urls) ? urls : []),
                ...(url ? [url] : []),
              ].filter(Boolean);

              if (!componentKey || incomingUrls.length === 0) {
                res.statusCode = 400;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(
                  JSON.stringify({
                    error: "componentKey and at least one url are required",
                  })
                );
                return;
              }

              const componentUrls = readFramerComponentUrls();
              const preferred = selectPreferredUrlForComponentKey(
                componentKey,
                incomingUrls
              );
              if (!preferred) {
                res.statusCode = 400;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(
                  JSON.stringify({ error: "No valid Framer CDN URL provided" })
                );
                return;
              }

              const nextUrls = [preferred];
              componentUrls[componentKey] = nextUrls;
              writeFramerComponentUrls(componentUrls);
              await runGenerateManifest();

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ componentKey, urls: nextUrls }));
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          });
        }
      );

      server.middlewares.use(
        "/__repo/discover-framer-component-urls",
        (req, res, next) => {
          if (requestMethod(req) !== "POST") {
            next();
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const { componentKey, displayName } = JSON.parse(body) as {
                componentKey?: string;
                displayName?: string;
              };

              if (!componentKey) {
                res.statusCode = 400;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(JSON.stringify({ error: "componentKey is required" }));
                return;
              }

              const discoveredUrls = discoverComponentUrls(
                componentKey,
                displayName
              );
              const componentUrls = readFramerComponentUrls();
              const preferred = selectPreferredUrlForComponentKey(
                componentKey,
                discoveredUrls
              );
              const nextUrls = preferred
                ? [preferred]
                : (componentUrls[componentKey] ?? []);

              if (nextUrls.length > 0) {
                componentUrls[componentKey] = nextUrls;
              }
              writeFramerComponentUrls(componentUrls);
              await runGenerateManifest();

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  componentKey,
                  discoveredUrls,
                  urls: nextUrls,
                })
              );
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          });
        }
      );

      server.middlewares.use(
        "/__repo/generate-sync-artifacts",
        (req, res, next) => {
          if (requestMethod(req) !== "POST") {
            next();
            return;
          }

          void (async () => {
            try {
              await runGenerateSyncArtifacts();

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  generated: [
                    "public/component-manifest.json",
                    "src/generated/framerComponentRegistry.tsx",
                    "framer-sync/RoleModel",
                  ],
                  ok: true,
                })
              );
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          })();
        }
      );

      server.middlewares.use(
        "/__repo/framer-project-components",
        (req, res, next) => {
          if (requestMethod(req) === "GET") {
            try {
              const components = readFramerProjectComponents();
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify(components, null, 2));
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
            return;
          }

          if (requestMethod(req) !== "POST") {
            next();
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const { components } = JSON.parse(body) as {
                components?: Record<
                  string,
                  {
                    key: string;
                    displayName: string;
                    category: string;
                    description: string;
                    status: "stable" | "beta" | "deprecated";
                    tags: string[];
                    isCanvas: boolean;
                    framerUrl?: string;
                    propCount: number;
                    source: "framer-project";
                    path?: string;
                    syncPath?: string;
                  }
                >;
              };

              if (!components || typeof components !== "object") {
                res.statusCode = 400;
                res.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8"
                );
                res.end(
                  JSON.stringify({ error: "components payload is required" })
                );
                return;
              }

              const nextComponents = replaceFramerProjectComponents(components);
              await runGenerateSyncArtifacts();

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  componentCount: Object.keys(nextComponents).length,
                  ok: true,
                })
              );
            } catch (error) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          });
        }
      );

      server.middlewares.use("/__repo/framer-sync-files", (req, res, next) => {
        if (requestMethod(req) !== "GET") {
          next();
          return;
        }

        try {
          const files = readDirectSyncFiles();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              files,
              root: "RoleModel",
            })
          );
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });
    },
    enforce: "pre",
    name: "serve-repo-component-manifest",
  };
};

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    rollupOptions: {
      // Plugin entry point — Framer loads this as an iframe
      input: "./index.html",
    },
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  plugins: [serveRepoManifest(), react()],
  preview: {
    host: "localhost",
    port: 4174,
    strictPort: true,
  },
  server: {
    cors: true,
    host: "localhost",
    https: getHttpsServerOptions(),
    port: 5173,
    strictPort: true,
  },
});
