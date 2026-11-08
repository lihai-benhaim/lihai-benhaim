import { describe, expect, it } from "vitest";
import { InstagramPublisher, PublishError, type LinkedAccount, type PublishMedia } from "../src/index.ts";
import { fakeFetch } from "./fake-fetch.ts";

const account: LinkedAccount = {
  platform: "instagram",
  externalUserId: "17841400000000000",
  displayName: "@me",
  scopes: [],
  credentials: { accessToken: "IG_TOKEN", refreshToken: null, expiresAt: null },
  meta: {},
};

const video: PublishMedia = {
  kind: "video",
  mimeType: "video/mp4",
  sizeBytes: 10,
  publicUrl: "https://studio.example.com/media/story.mp4?sig=x",
  read: async () => new Uint8Array(10),
};

describe("InstagramPublisher", () => {
  it("publishes a story video: container, wait, publish", async () => {
    let polls = 0;
    const { fn, calls } = fakeFetch([
      ["POST", "/17841400000000000/media_publish", () => ({ json: { id: "media-1" } })],
      ["POST", "/17841400000000000/media", () => ({ json: { id: "container-1" } })],
      ["GET", "/container-1?", () => ({ json: { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" } })],
      ["GET", "/media-1?", () => ({ json: {} })],
    ]);
    const ig = new InstagramPublisher({ appId: "app", appSecret: "secret", fetch: fn, sleep: async () => {} });

    const out = await ig.publish(account, {
      target: { platform: "instagram", format: "story" },
      rendition: { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
      media: [video],
    });

    expect(out).toEqual({ externalId: "media-1", url: null });
    const create = new URLSearchParams(calls[0]!.body as string);
    expect(create.get("media_type")).toBe("STORIES");
    expect(create.get("video_url")).toBe(video.publicUrl);
    expect(polls).toBe(3);
    expect(new URLSearchParams(calls.find((c) => c.url.includes("media_publish"))!.body as string).get("creation_id")).toBe(
      "container-1",
    );
  });

  it("fails when Instagram cannot process the media", async () => {
    const { fn } = fakeFetch([
      ["POST", "/media", () => ({ json: { id: "c" } })],
      ["GET", "/c?", () => ({ json: { status_code: "ERROR", status: "Unsupported codec" } })],
    ]);
    const ig = new InstagramPublisher({ appId: "app", appSecret: "secret", fetch: fn, sleep: async () => {} });
    await expect(
      ig.publish(account, {
        target: { platform: "instagram", format: "reel" },
        rendition: { platform: "instagram", format: "reel", caption: "hi", hashtags: [], title: null, linkUrl: null },
        media: [video],
      }),
    ).rejects.toThrow(/Unsupported codec/);
  });

  it("marks rate limits as retryable and keeps tokens out of errors", async () => {
    const { fn } = fakeFetch([["POST", "/media", () => new Response("slow down", { status: 429 })]]);
    const ig = new InstagramPublisher({ appId: "app", appSecret: "secret", fetch: fn, sleep: async () => {} });
    const err = await ig
      .publish(account, {
        target: { platform: "instagram", format: "story" },
        rendition: { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
        media: [video],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).retryable).toBe(true);
    expect((err as PublishError).message).not.toContain("IG_TOKEN");
  });

  it("links an account with a long-lived token", async () => {
    const { fn } = fakeFetch([
      ["POST", "api.instagram.com/oauth/access_token", () => ({ json: { data: [{ access_token: "short", user_id: 1 }] } })],
      ["GET", "graph.instagram.com/access_token", () => ({ json: { access_token: "long", expires_in: 5_184_000 } })],
      ["GET", "/me?", () => ({ json: { id: "app-scoped", user_id: "17841400000000000", username: "lihai" } })],
    ]);
    const ig = new InstagramPublisher({ appId: "app", appSecret: "secret", fetch: fn });
    const linked = await ig.completeAuthorization({ code: "c", redirectUri: "https://studio.example.com/cb" });
    expect(linked.externalUserId).toBe("17841400000000000");
    expect(linked.displayName).toBe("@lihai");
    expect(linked.credentials.accessToken).toBe("long");
    expect(ig.authorizationUrl({ state: "s", redirectUri: "https://x/cb" })).toContain("instagram_business_content_publish");
  });
});
