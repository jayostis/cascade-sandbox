import { parseArgs } from "node:util";
import { HospitalDataError, isInstant } from "../history.js";
import { hospitalId } from "../route.js";
import { loadHospitals } from "./index.js";
import { serveDemo } from "./serve.js";

const USAGE =
  "usage: npm run serve -- [--port <n>] [--as-of <instant>] [--host <name>]...";

const isMisuse = (error: unknown) =>
  error instanceof TypeError &&
  String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS_");

const parse = () =>
  parseArgs({
    options: {
      port: { type: "string" },
      "as-of": { type: "string" },
      host: { type: "string", multiple: true },
    },
  });

function portOf(text: string | undefined): number | undefined {
  if (text === undefined) return 0;
  const port = Number(text);
  return /^\d+$/.test(text) && port <= 65535 ? port : undefined;
}

function isHostName(text: string): boolean {
  try {
    return new URL(`http://${text}`).hostname === text.toLowerCase();
  } catch {
    return false;
  }
}

function misuse(words?: string): void {
  console.error(words === undefined ? USAGE : `${USAGE}\n${words}`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (error) {
    if (!isMisuse(error)) throw error;
    return misuse();
  }
  const port = portOf(args.values.port);
  if (port === undefined) return misuse("--port is a number up to 65535.");
  const asOf = args.values["as-of"];
  if (asOf !== undefined && !isInstant(asOf))
    return misuse("--as-of is an instant, as 2024-02-01T00:00:00Z.");
  const hosts = args.values.host ?? [];
  if (!hosts.every(isHostName))
    return misuse("--host is a name with no port, as sandbox.example.");
  const hospitals = await loadHospitals();
  const listener = await serveDemo(hospitals, {
    port,
    hosts,
    ...(asOf === undefined ? {} : { asOf }),
  });
  const { origin } = listener;
  const { port: listening } = new URL(origin);
  console.log(`Listening at ${origin}`);
  for (const at of [
    origin,
    ...["host.docker.internal", ...hosts].map(
      (name) => `http://${name.toLowerCase()}:${listening}`,
    ),
  ])
    for (const each of hospitals) {
      const id = hospitalId(each);
      const path = new URL(each.hospital.fhirBase).pathname.replace(/\/$/, "");
      console.log(`hospital ${id} ${at}/${id}${path} ${each.hospital.name}`);
    }
  console.log(
    `Move the world's date: curl -d asOf=2024-02-01T00:00:00Z ${origin}/world-date (asOf= for every version)`,
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof HospitalDataError
      ? error.message
      : error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `${USAGE}\nThat port is in use: give another, or none for one the system picks.`
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
  );
  process.exitCode = 1;
});
