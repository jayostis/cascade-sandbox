import { readFile, stat } from "node:fs/promises";
import { HospitalDataError } from "../history.js";
import type { Bundle } from "../types.js";

/** What `path` is, by asking the file system about it: reading a folder as a file fails differently on each system. */
export async function kind(
  path: string,
): Promise<"folder" | "file" | undefined> {
  try {
    const found = await stat(path);
    return found.isDirectory() ? "folder" : found.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === "string");

export async function readJson(path: string, where: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new HospitalDataError(
      where,
      `is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Refuses a file that is not a Bundle-shaped object whose entries are objects, before anything reads inside it. */
export function checkBundle(value: unknown, where: string): Bundle {
  if (!isObject(value)) throw new HospitalDataError(where, "is not an object");
  const { entry } = value;
  if (
    entry !== undefined &&
    (!Array.isArray(entry) ||
      entry.some(
        (one) =>
          !isObject(one) ||
          (one.resource !== undefined && !isObject(one.resource)),
      ))
  )
    throw new HospitalDataError(
      where,
      "has an entry that is not an object, or whose resource is not",
    );
  return value as unknown as Bundle;
}
