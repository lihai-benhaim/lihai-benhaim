import type { PlatformId } from "@studio/core";
import type { LinkedAccount, PublishOutcome, PublishRequest, Publisher } from "./types.ts";

export interface DryRunRecord {
  account: string;
  request: PublishRequest;
  at: string;
}

/**
 * Stands in for a real network during development: linking "succeeds"
 * immediately and publishing records the post instead of sending it.
 * Results are clearly marked as dry runs so they are never mistaken for posts.
 */
export class DryRunPublisher implements Publisher {
  readonly platform: PlatformId;
  readonly records: DryRunRecord[] = [];

  constructor(platform: PlatformId) {
    this.platform = platform;
  }

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({ code: "dry-run", state });
    return `${redirectUri}?${q}`;
  }

  async completeAuthorization(): Promise<LinkedAccount> {
    return {
      platform: this.platform,
      externalUserId: `dry-run-${this.platform}`,
      displayName: `Dry run (${this.platform})`,
      scopes: [],
      credentials: { accessToken: "dry-run", refreshToken: null, expiresAt: null },
      meta: { dryRun: "true" },
    };
  }

  async publish(account: LinkedAccount, request: PublishRequest): Promise<PublishOutcome> {
    this.records.push({ account: account.externalUserId, request, at: new Date().toISOString() });
    return { externalId: `dry-run-${this.platform}-${this.records.length}`, url: null };
  }
}
