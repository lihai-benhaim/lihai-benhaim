import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { Secrets } from "./secrets.ts";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
};

export function extensionFor(mimeType: string): string {
  return EXT[mimeType] ?? "bin";
}

export function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}

/**
 * Files on the NAS volume, addressed by key ("drafts/<id>/assets/<file>").
 * Public URLs are signed and expire, so rendered media is reachable by
 * Instagram/WhatsApp servers without making the folder public.
 */
export class MediaStore {
  readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly secrets: Secrets;

  constructor(root: string, publicBaseUrl: string, secrets: Secrets) {
    this.root = root;
    this.publicBaseUrl = publicBaseUrl;
    this.secrets = secrets;
  }

  /** Absolute path for a key; rejects keys that escape the root. */
  path(key: string): string {
    const clean = normalize(key).replace(/^([/\\])+/, "");
    if (clean.startsWith("..") || clean.split(sep).includes("..")) throw new Error("invalid media key");
    return join(this.root, clean);
  }

  keyFor(absPath: string): string {
    return relative(this.root, absPath).split(sep).join("/");
  }

  async put(key: string, bytes: Uint8Array): Promise<{ key: string; sha256: string; sizeBytes: number }> {
    const abs = this.path(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    return { key, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  publicUrl(key: string, ttlSec = 24 * 3600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = this.secrets.sign(`${key}:${exp}`);
    return `${this.publicBaseUrl}/media/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
  }

  verifyUrl(key: string, exp: string | undefined, sig: string | undefined): boolean {
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    return this.secrets.verify(`${key}:${exp}`, sig);
  }
}
