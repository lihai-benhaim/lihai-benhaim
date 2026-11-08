import type { PlatformId, Rendition, Target } from "@studio/core";

export interface AccountCredentials {
  accessToken: string;
  refreshToken: string | null;
  /** ISO timestamp, or null when the platform did not say. */
  expiresAt: string | null;
}

/** An account the owner linked through the platform's OAuth flow. */
export interface LinkedAccount {
  platform: PlatformId;
  /** The id the platform uses for this account in publishing calls. */
  externalUserId: string;
  displayName: string;
  scopes: string[];
  credentials: AccountCredentials;
  meta: Record<string, string>;
}

export interface PublishMedia {
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  /**
   * HTTPS URL the platform's servers can download from (Instagram, Threads and
   * Facebook pull media by URL). Must be reachable from the internet.
   */
  publicUrl: string;
  /** Raw bytes, for platforms that take uploads (LinkedIn, YouTube, X). */
  read(): Promise<Uint8Array>;
}

export interface PublishRequest {
  target: Target;
  rendition: Rendition;
  media: PublishMedia[];
}

export interface PublishOutcome {
  externalId: string;
  url: string | null;
}

export interface Publisher {
  readonly platform: PlatformId;
  /** Where to send the owner to grant access. `state` must be verified on callback. */
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  /** Exchanges the OAuth code for credentials and reads the account's identity. */
  completeAuthorization(input: { code: string; redirectUri: string }): Promise<LinkedAccount>;
  /** Publishes one rendition. Called only for drafts the owner approved. */
  publish(account: LinkedAccount, request: PublishRequest): Promise<PublishOutcome>;
}

export class PublishError extends Error {
  readonly platform: PlatformId;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(platform: PlatformId, message: string, opts: { status?: number | null; retryable?: boolean } = {}) {
    super(`[${platform}] ${message}`);
    this.name = "PublishError";
    this.platform = platform;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? false;
  }
}
