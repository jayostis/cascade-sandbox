import { execFile } from "node:child_process";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("../../../", import.meta.url));
const COPY = join(PACKAGE, "vocabulary");
const FOLDER = "people";
const USAGE =
  "usage: npm run people -- [--check] <cascade-vocabulary checkout>";

const git = async (checkout: string, args: string[]): Promise<Buffer> =>
  (
    await promisify(execFile)("git", ["-C", checkout, ...args], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    })
  ).stdout;

/** A checkout that cannot give the pinned commit's people: a usage error, said in one sentence. */
class Unpinned extends Error {}

/** Every file under the vocabulary's `people/` at the pinned commit, by its path there. */
async function pinned(checkout: string): Promise<Map<string, Buffer>> {
  const { commit } = JSON.parse(
    await readFile(join(PACKAGE, "vocabulary.json"), "utf8"),
  ) as { commit: string };
  let listed: Buffer;
  try {
    listed = await git(checkout, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      FOLDER,
    ]);
  } catch {
    throw new Unpinned(
      `${checkout} does not hold ${commit}: check out the pinned commit`,
    );
  }
  const paths = listed
    .toString("utf8")
    .split("\n")
    .filter((path) => path !== "");
  if (paths.length === 0)
    throw new Unpinned(`${checkout} has no ${FOLDER}/ at ${commit}`);
  const files = new Map<string, Buffer>();
  for (const path of paths)
    files.set(path, await git(checkout, ["show", `${commit}:${path}`]));
  return files;
}

/** Every file of the copy, by its path under `vocabulary/`. */
async function copied(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let entries;
  try {
    entries = await readdir(join(COPY, FOLDER), {
      recursive: true,
      withFileTypes: true,
    });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(COPY, path).split(sep).join("/"), await readFile(path));
  }
  return files;
}

/** Whether two files say the same: a `.json` as parsed JSON, any other as text with its line endings ignored. */
function same(path: string, one: Buffer, other: Buffer): boolean {
  const text = (bytes: Buffer) => bytes.toString("utf8").replace(/\r\n/g, "\n");
  if (!path.endsWith(".json")) return text(one) === text(other);
  try {
    return isDeepStrictEqual(JSON.parse(text(one)), JSON.parse(text(other)));
  } catch {
    return false;
  }
}

async function check(checkout: string): Promise<string[]> {
  const [want, have] = await Promise.all([pinned(checkout), copied()]);
  const wrong: string[] = [];
  for (const [path, bytes] of want) {
    const held = have.get(path);
    if (held === undefined) wrong.push(`vocabulary/${path} is missing`);
    else if (!same(path, bytes, held))
      wrong.push(`vocabulary/${path} differs from the pinned commit`);
  }
  for (const path of have.keys())
    if (!want.has(path))
      wrong.push(`vocabulary/${path} is not at the pinned commit`);
  return wrong;
}

async function copy(checkout: string): Promise<number> {
  const files = await pinned(checkout);
  await rm(join(COPY, FOLDER), { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const to = join(COPY, ...path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
  }
  return files.size;
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { check: { type: "boolean" } },
  });
} catch {
  args = undefined;
}
const checkout = args?.positionals[0];
if (
  args === undefined ||
  checkout === undefined ||
  args.positionals.length > 1
) {
  console.error(USAGE);
  process.exitCode = 2;
} else
  try {
    if (args.values.check) {
      const wrong = await check(checkout);
      for (const line of wrong) console.error(line);
      if (wrong.length > 0) process.exitCode = 1;
      else console.log("vocabulary/people/ is the pinned commit's people/");
    } else
      console.log(
        `Copied ${await copy(checkout)} files into vocabulary/people/`,
      );
  } catch (error) {
    if (!(error instanceof Unpinned)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
