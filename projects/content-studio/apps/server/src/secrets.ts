import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encrypts OAuth tokens at rest (AES-256-GCM) and signs short-lived links
 * (OAuth state, media URLs) with HMAC-SHA256. Encryption and signing use
 * separate keys derived from APP_SECRET_KEY.
 */
export class Secrets {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(base64Key: string) {
    const master = Buffer.from(base64Key, "base64");
    if (master.length < 32) throw new Error("APP_SECRET_KEY must be at least 32 bytes, base64 encoded (openssl rand -base64 32)");
    this.encKey = createHash("sha256").update(Buffer.concat([Buffer.from("enc:"), master])).digest();
    this.macKey = createHash("sha256").update(Buffer.concat([Buffer.from("mac:"), master])).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  sign(data: string): string {
    return createHmac("sha256", this.macKey).update(data).digest("base64url");
  }

  verify(data: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(data));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Signed, expiring token carrying a small JSON payload (used for OAuth state). */
  seal(payload: Record<string, unknown>, ttlSec: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  unseal<T extends Record<string, unknown>>(token: string): T | null {
    const [body, sig] = token.split(".");
    if (!body || !sig || !this.verify(body, sig)) return null;
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return data.exp >= Math.floor(Date.now() / 1000) ? data : null;
  }
}
