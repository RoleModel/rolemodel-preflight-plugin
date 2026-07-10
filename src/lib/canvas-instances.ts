/**
 * Read-only inventory of canvas component instances by module URL (insertURL).
 * Framer does not expose updating insertURL via the Plugin API — use this for migration planning.
 */

export interface ComponentInstanceSummary {
  id: string;
  insertURL: string | null;
  componentName: string | null;
  componentIdentifier: string;
}

export function groupInstancesByInsertUrl(
  instances: ComponentInstanceSummary[]
): Map<string, ComponentInstanceSummary[]> {
  const map = new Map<string, ComponentInstanceSummary[]>();
  for (const inst of instances) {
    const key = inst.insertURL ?? "(null insertURL)";
    const list = map.get(key) ?? [];
    list.push(inst);
    map.set(key, list);
  }
  return map;
}

export function formatCanvasInstanceReport(
  instances: ComponentInstanceSummary[],
  options?: { maxIdsPerUrl?: number }
): string {
  const maxIds = options?.maxIdsPerUrl ?? 8;
  if (instances.length === 0) {
    return "No ComponentInstanceNode instances found on the canvas (or API returned empty).";
  }

  const grouped = groupInstancesByInsertUrl(instances);
  const urls = [...grouped.keys()].toSorted((a, b) => a.localeCompare(b));
  const suspiciousUrls = urls.filter((url) => {
    const lower = url.toLowerCase();
    return (
      url === "(null insertURL)" ||
      lower.includes("/404-") ||
      lower.includes("!missing") ||
      lower.includes("#framer/local") ||
      lower.includes("framercanvas.com")
    );
  });

  const lines: string[] = [
    `Canvas component instances: ${instances.length} total, ${grouped.size} distinct module URL(s).`,
    "",
    "This inventory is read-only. Framer’s plugin API cannot rewrite insertURL on existing instances.",
  ];

  if (suspiciousUrls.length === 0) {
    lines.push("No suspicious canvas module URLs found in the quick scan.", "");
    return lines.join("\n").trimEnd();
  }

  lines.push(
    `Suspicious canvas module URL groups (${suspiciousUrls.length}) — inspect these first:`,
    ""
  );

  for (const url of suspiciousUrls) {
    const list = grouped.get(url) ?? [];
    lines.push(`— ${list.length}× ${url}`);
    const idSample = list
      .slice(0, maxIds)
      .map((i) => `${i.id}${i.componentName ? ` (${i.componentName})` : ""}`);
    for (const row of idSample) {
      lines.push(`    ${row}`);
    }
    if (list.length > maxIds) {
      lines.push(`    … +${list.length - maxIds} more node id(s)`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
