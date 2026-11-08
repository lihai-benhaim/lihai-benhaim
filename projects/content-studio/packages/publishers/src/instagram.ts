import { composeCaption } from "@studio/core";
import { defaultSleep, form, requestJson, type FetchLike } from "./http.ts";
import { PublishError, type LinkedAccount, type PublishOutcome, type PublishRequest, type Publisher } from "./types.ts";

/**
 * Instagram publishing through the "Instagram API with Instagram Login".
 *
 * Flow per post: create a media container from a public media URL, wait until
 * Instagram has processed it, then publish the container.
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 *
 * Requires a professional (Business or Creator) account and an app with the
 * instagram_business_basic and instagram_business_content_publish permissions
 * (App Review is needed before accounts other than the app's testers can link).
 */
export interface InstagramConfig {
  appId: string;
  appSecret: string;
  /** Graph API version, e.g. "v23.0". Check the changelog when upgrading. */
  graphVersion?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

export class InstagramPublisher implements Publisher {
  readonly platform = "instagram" as const;
  private readonly cfg: Required<Omit<InstagramConfig, "fetch" | "sleep">>;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: InstagramConfig) {
    this.cfg = {
      appId: config.appId,
      appSecret: config.appSecret,
      graphVersion: config.graphVersion ?? "v23.0",
      pollIntervalMs: config.pollIntervalMs ?? 3000,
      maxPollAttempts: config.maxPollAttempts ?? 100,
    };
    this.fetchFn = config.fetch ?? fetch;
    this.sleep = config.sleep ?? defaultSleep;
  }

  private graph(path: string): string {
    return `https://graph.instagram.com/${this.cfg.graphVersion}/${path}`;
  }

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      client_id: this.cfg.appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  }

  async completeAuthorization({ code, redirectUri }: { code: string; redirectUri: string }): Promise<LinkedAccount> {
    type ShortLived = { access_token?: string; user_id?: string | number; data?: { access_token: string; user_id: string | number }[] };
    const { data: short } = await requestJson<ShortLived>(this.fetchFn, this.platform, "https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: form({
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });
    const shortToken = short.access_token ?? short.data?.[0]?.access_token;
    if (!shortToken) throw new PublishError(this.platform, "token exchange returned no access token");

    // Exchange for a long-lived token (about 60 days, refreshable).
    const longQ = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: this.cfg.appSecret, access_token: shortToken });
    const { data: long } = await requestJson<{ access_token: string; expires_in: number }>(
      this.fetchFn,
      this.platform,
      `https://graph.instagram.com/access_token?${longQ}`,
    );

    const meQ = new URLSearchParams({ fields: "user_id,username", access_token: long.access_token });
    const { data: me } = await requestJson<{ id: string; user_id?: string | number; username: string }>(
      this.fetchFn,
      this.platform,
      this.graph(`me?${meQ}`),
    );

    return {
      platform: this.platform,
      externalUserId: String(me.user_id ?? me.id),
      displayName: `@${me.username}`,
      scopes: SCOPES,
      credentials: {
        accessToken: long.access_token,
        refreshToken: null,
        expiresAt: new Date(Date.now() + long.expires_in * 1000).toISOString(),
      },
      meta: { username: me.username },
    };
  }

  async publish(account: LinkedAccount, req: PublishRequest): Promise<PublishOutcome> {
    const token = account.credentials.accessToken;
    const caption = composeCaption(req.rendition);
    const [first] = req.media;
    if (!first) throw new PublishError(this.platform, `${req.target.format} needs media`);

    let containerId: string;
    switch (req.target.format) {
      case "story":
        containerId = await this.createContainer(account, token, {
          media_type: "STORIES",
          ...(first.kind === "video" ? { video_url: first.publicUrl } : { image_url: first.publicUrl }),
        });
        break;
      case "reel":
        if (first.kind !== "video") throw new PublishError(this.platform, "a reel needs a video");
        containerId = await this.createContainer(account, token, { media_type: "REELS", video_url: first.publicUrl, caption });
        break;
      case "feed_image":
        containerId = await this.createContainer(account, token, { image_url: first.publicUrl, caption });
        break;
      case "carousel": {
        const children: string[] = [];
        for (const m of req.media) {
          const child = await this.createContainer(account, token, {
            is_carousel_item: "true",
            ...(m.kind === "video" ? { media_type: "VIDEO", video_url: m.publicUrl } : { image_url: m.publicUrl }),
          });
          await this.waitUntilReady(child, token);
          children.push(child);
        }
        containerId = await this.createContainer(account, token, { media_type: "CAROUSEL", children: children.join(","), caption });
        break;
      }
      default:
        throw new PublishError(this.platform, `format ${req.target.format} is not supported`);
    }

    await this.waitUntilReady(containerId, token);

    const { data: published } = await requestJson<{ id: string }>(
      this.fetchFn,
      this.platform,
      this.graph(`${account.externalUserId}/media_publish`),
      { method: "POST", body: form({ creation_id: containerId, access_token: token }) },
    );

    return { externalId: published.id, url: await this.permalink(published.id, token) };
  }

  private async createContainer(account: LinkedAccount, token: string, params: Record<string, string>): Promise<string> {
    const { data } = await requestJson<{ id: string }>(this.fetchFn, this.platform, this.graph(`${account.externalUserId}/media`), {
      method: "POST",
      body: form({ ...params, access_token: token }),
    });
    return data.id;
  }

  private async waitUntilReady(containerId: string, token: string): Promise<void> {
    const q = new URLSearchParams({ fields: "status_code,status", access_token: token });
    for (let attempt = 0; attempt < this.cfg.maxPollAttempts; attempt++) {
      const { data } = await requestJson<{ status_code: string; status?: string }>(
        this.fetchFn,
        this.platform,
        this.graph(`${containerId}?${q}`),
      );
      if (data.status_code === "FINISHED" || data.status_code === "PUBLISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new PublishError(this.platform, `media processing failed: ${data.status ?? data.status_code}`);
      }
      await this.sleep(this.cfg.pollIntervalMs);
    }
    throw new PublishError(this.platform, "media processing timed out", { retryable: true });
  }

  private async permalink(mediaId: string, token: string): Promise<string | null> {
    try {
      const q = new URLSearchParams({ fields: "permalink", access_token: token });
      const { data } = await requestJson<{ permalink?: string }>(this.fetchFn, this.platform, this.graph(`${mediaId}?${q}`));
      return data.permalink ?? null;
    } catch {
      return null; // Stories have no stable permalink; not worth failing a published post over.
    }
  }
}
