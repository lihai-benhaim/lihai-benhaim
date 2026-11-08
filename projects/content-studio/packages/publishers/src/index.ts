import type { PlatformId } from "@studio/core";
import type { Publisher } from "./types.ts";

export * from "./types.ts";
export * from "./http.ts";
export { InstagramPublisher, type InstagramConfig } from "./instagram.ts";
export { LinkedInPublisher, escapeLittleText, linkedInCommentary, type LinkedInConfig } from "./linkedin.ts";
export { DryRunPublisher, type DryRunRecord } from "./dry-run.ts";

export class PublisherRegistry {
  private readonly byPlatform = new Map<PlatformId, Publisher>();

  constructor(publishers: Publisher[] = []) {
    for (const p of publishers) this.register(p);
  }

  register(publisher: Publisher): this {
    this.byPlatform.set(publisher.platform, publisher);
    return this;
  }

  get(platform: PlatformId): Publisher | undefined {
    return this.byPlatform.get(platform);
  }

  platforms(): PlatformId[] {
    return [...this.byPlatform.keys()];
  }
}
