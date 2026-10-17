import type { Resource } from "./types.js";

export function parseUrl(text: string | null): URL | undefined {
  if (!text) return undefined;
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

export function positive(text: string | null): number | undefined {
  const value = Number(text);
  return text !== null && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function pagePosition(offset: number): string {
  return btoa(`at:${offset}`).replace(/=+$/, "");
}

export function position(page: string): number | undefined {
  try {
    const match = /^at:(\d+)$/.exec(atob(page));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

interface Coding {
  system?: string;
  code?: string;
}

export function categories(resource: Resource): Coding[] {
  const category = resource.category;
  if (!Array.isArray(category)) return [];
  return category.flatMap(
    (concept: { coding?: Coding[] }) => concept.coding ?? [],
  );
}

export function token(text: string): { system?: string; code: string } {
  const bar = text.indexOf("|");
  return bar === -1
    ? { code: text }
    : { system: text.slice(0, bar), code: text.slice(bar + 1) };
}

/** The letters of `cruds` that a token's scopes grant on `type`. */
export function granted(scopes: string, type: string): string {
  const letters = new Set<string>();
  for (const scope of scopes.split(" ")) {
    const match = /^patient\/(\*|[A-Za-z]+)\.(read|write|\*|c?r?u?d?s?)$/.exec(
      scope,
    );
    if (!match || (match[1] !== "*" && match[1] !== type)) continue;
    const asked = match[2] ?? "";
    const given =
      asked === "read"
        ? "rs"
        : asked === "write"
          ? "cud"
          : asked === "*"
            ? "cruds"
            : asked;
    for (const letter of given) letters.add(letter);
  }
  return [...letters].join("");
}

export function patientId(
  reference: string | null,
  base: string,
): string | null {
  for (const prefix of [`${base}/Patient/`, "Patient/"]) {
    if (reference?.startsWith(prefix)) return reference.slice(prefix.length);
  }
  return reference;
}
