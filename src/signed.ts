const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return base64url(new Uint8Array(digest));
}

export class Signer {
  readonly #secret: string;
  #imported?: Promise<CryptoKey>;

  constructor(secret: string) {
    this.#secret = secret;
  }

  get #key(): Promise<CryptoKey> {
    this.#imported ??= crypto.subtle.importKey(
      "raw",
      encoder.encode(this.#secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.#imported;
  }

  async sign(note: object): Promise<string> {
    const body = base64url(encoder.encode(JSON.stringify(note)));
    const mac = await crypto.subtle.sign(
      "HMAC",
      await this.#key,
      encoder.encode(body),
    );
    return `${body}.${base64url(new Uint8Array(mac))}`;
  }

  async verify(signed: string): Promise<Record<string, unknown> | undefined> {
    const parts = signed.split(".");
    if (parts.length !== 2) return undefined;
    const [body, mac] = parts as [string, string];
    const macBytes = fromBase64url(mac);
    const bodyBytes = fromBase64url(body);
    if (!macBytes || !bodyBytes) return undefined;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.#key,
      macBytes,
      encoder.encode(body),
    );
    if (!valid) return undefined;
    try {
      const note: unknown = JSON.parse(decoder.decode(bodyBytes));
      return typeof note === "object" && note !== null && !Array.isArray(note)
        ? (note as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
