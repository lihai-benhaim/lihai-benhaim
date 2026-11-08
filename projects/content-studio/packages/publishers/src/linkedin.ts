import { defaultSleep, form, requestJson, type FetchLike } from "./http.ts";
import { PublishError, type LinkedAccount, type PublishMedia, type PublishOutcome, type PublishRequest, type Publisher } from "./types.ts";

/**
 * LinkedIn publishing to the member's own profile through the Posts API.
 * Docs: https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 *
 * Needs the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID
 * Connect" products on the LinkedIn app (scopes: openid profile w_member_social).
 */
export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  /** Versioned API, YYYYMM. LinkedIn supports each version for about a year. */
  apiVersion?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  videoPollIntervalMs?: number;
  videoMaxPollAttempts?: number;
}

const SCOPES = ["openid", "profile", "w_member_social"];
const API = "https://api.linkedin.com/rest";

/**
 * LinkedIn's "little text" format treats these characters as markup; plain
 * text has to escape them or the API rejects or mangles the post.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

export function linkedInCommentary(caption: string, hashtags: string[]): string {
  const body = escapeLittleText(caption);
  const tags = hashtags
    .map((h) => h.replace(/^#/, "").replace(/\s+/g, ""))
    .filter(Boolean)
    .map((h) => `{hashtag|\\#|${escapeLittleText(h)}}`)
    .join(" ");
  if (!tags) return body;
  return body ? `${body}\n\n${tags}` : tags;
}

export class LinkedInPublisher implements Publisher {
  readonly platform = "linkedin" as const;
  private readonly cfg: Required<Omit<LinkedInConfig, "fetch" | "sleep">>;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: LinkedInConfig) {
    this.cfg = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      apiVersion: config.apiVersion ?? "202510",
      videoPollIntervalMs: config.videoPollIntervalMs ?? 5000,
      videoMaxPollAttempts: config.videoMaxPollAttempts ?? 60,
    };
    this.fetchFn = config.fetch ?? fetch;
    this.sleep = config.sleep ?? defaultSleep;
  }

  authorizationUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPES.join(" "),
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
  }

  async completeAuthorization({ code, redirectUri }: { code: string; redirectUri: string }): Promise<LinkedAccount> {
    const { data: token } = await requestJson<{
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope?: string;
    }>(this.fetchFn, this.platform, "https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      body: form({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });

    const { data: me } = await requestJson<{ sub: string; name?: string }>(
      this.fetchFn,
      this.platform,
      "https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );

    return {
      platform: this.platform,
      externalUserId: `urn:li:person:${me.sub}`,
      displayName: me.name ?? "LinkedIn member",
      scopes: token.scope ? token.scope.split(/[ ,]/).filter(Boolean) : SCOPES,
      credentials: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      },
      meta: {},
    };
  }

  async publish(account: LinkedAccount, req: PublishRequest): Promise<PublishOutcome> {
    const author = account.externalUserId;
    const token = account.credentials.accessToken;
    const commentary = linkedInCommentary(req.rendition.caption, req.rendition.hashtags);

    let content: Record<string, unknown> | undefined;
    const [media] = req.media;
    if (req.target.format === "feed_image") {
      if (!media || media.kind !== "image") throw new PublishError(this.platform, "feed_image needs an image");
      content = { media: { id: await this.uploadImage(author, token, media) } };
    } else if (req.target.format === "feed_video") {
      if (!media || media.kind !== "video") throw new PublishError(this.platform, "feed_video needs a video");
      content = { media: { id: await this.uploadVideo(author, token, media), title: req.rendition.title ?? undefined } };
    } else if (req.target.format !== "text") {
      throw new PublishError(this.platform, `format ${req.target.format} is not supported`);
    }

    const res = await requestJson<Record<string, unknown>>(this.fetchFn, this.platform, `${API}/posts`, {
      method: "POST",
      headers: this.headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        author,
        commentary,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      }),
    });
    const urn = res.headers.get("x-restli-id");
    if (!urn) throw new PublishError(this.platform, "post created but LinkedIn returned no id");
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": this.cfg.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      ...extra,
    };
  }

  private async uploadImage(owner: string, token: string, media: PublishMedia): Promise<string> {
    const { data } = await requestJson<{ value: { uploadUrl: string; image: string } }>(
      this.fetchFn,
      this.platform,
      `${API}/images?action=initializeUpload`,
      {
        method: "POST",
        headers: this.headers(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
      },
    );
    await this.put(data.value.uploadUrl, token, await media.read(), media.mimeType);
    return data.value.image;
  }

  private async uploadVideo(owner: string, token: string, media: PublishMedia): Promise<string> {
    const bytes = await media.read();
    const { data } = await requestJson<{
      value: {
        video: string;
        uploadToken: string;
        uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[];
      };
    }>(this.fetchFn, this.platform, `${API}/videos?action=initializeUpload`, {
      method: "POST",
      headers: this.headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        initializeUploadRequest: { owner, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false },
      }),
    });

    const partIds: string[] = [];
    for (const part of data.value.uploadInstructions) {
      const etag = await this.put(part.uploadUrl, token, bytes.subarray(part.firstByte, part.lastByte + 1), "application/octet-stream");
      if (!etag) throw new PublishError(this.platform, "video part upload returned no ETag");
      partIds.push(etag);
    }

    await requestJson(this.fetchFn, this.platform, `${API}/videos?action=finalizeUpload`, {
      method: "POST",
      headers: this.headers(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        finalizeUploadRequest: { video: data.value.video, uploadToken: data.value.uploadToken, uploadedPartIds: partIds },
      }),
    });

    await this.waitForVideo(data.value.video, token);
    return data.value.video;
  }

  private async waitForVideo(urn: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < this.cfg.videoMaxPollAttempts; attempt++) {
      const { data } = await requestJson<{ status?: string }>(
        this.fetchFn,
        this.platform,
        `${API}/videos/${encodeURIComponent(urn)}`,
        { headers: this.headers(token) },
      );
      if (data.status === "AVAILABLE") return;
      if (data.status === "PROCESSING_FAILED") throw new PublishError(this.platform, "LinkedIn could not process the video");
      await this.sleep(this.cfg.videoPollIntervalMs);
    }
    throw new PublishError(this.platform, "video processing timed out", { retryable: true });
  }

  private async put(url: string, token: string, body: Uint8Array, contentType: string): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        body: body as unknown as RequestInit["body"],
      });
    } catch (cause) {
      throw new PublishError(this.platform, `upload failed: ${(cause as Error).message}`, { retryable: true });
    }
    if (!res.ok) {
      throw new PublishError(this.platform, `upload failed with ${res.status}: ${(await res.text()).slice(0, 300)}`, {
        status: res.status,
        retryable: res.status >= 500,
      });
    }
    return res.headers.get("etag");
  }
}
