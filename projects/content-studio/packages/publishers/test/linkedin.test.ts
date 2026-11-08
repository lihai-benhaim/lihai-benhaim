import { describe, expect, it } from "vitest";
import { LinkedInPublisher, linkedInCommentary, type LinkedAccount } from "../src/index.ts";
import { fakeFetch } from "./fake-fetch.ts";

const account: LinkedAccount = {
  platform: "linkedin",
  externalUserId: "urn:li:person:abc",
  displayName: "Me",
  scopes: [],
  credentials: { accessToken: "LI_TOKEN", refreshToken: null, expiresAt: null },
  meta: {},
};

describe("LinkedIn commentary", () => {
  it("escapes little-text markup and formats hashtags", () => {
    expect(linkedInCommentary("Hello (world) #1 @you", ["AI", "build tools"])).toBe(
      "Hello \\(world\\) \\#1 \\@you\n\n{hashtag|\\#|AI} {hashtag|\\#|buildtools}",
    );
  });
});

describe("LinkedInPublisher", () => {
  it("uploads a video in parts, finalizes, then creates the post", async () => {
    const bytes = new Uint8Array(10).map((_, i) => i);
    const { fn, calls } = fakeFetch([
      [
        "POST",
        "/rest/videos?action=initializeUpload",
        () => ({
          json: {
            value: {
              video: "urn:li:video:v1",
              uploadToken: "tok",
              uploadInstructions: [
                { uploadUrl: "https://upload.example/p1", firstByte: 0, lastByte: 5 },
                { uploadUrl: "https://upload.example/p2", firstByte: 6, lastByte: 9 },
              ],
            },
          },
        }),
      ],
      ["PUT", "upload.example/p1", () => new Response("", { headers: { etag: "e1" } })],
      ["PUT", "upload.example/p2", () => new Response("", { headers: { etag: "e2" } })],
      ["POST", "/rest/videos?action=finalizeUpload", () => ({ json: {} })],
      ["GET", "/rest/videos/", () => ({ json: { status: "AVAILABLE" } })],
      ["POST", "/rest/posts", () => ({ json: {}, status: 201, headers: { "x-restli-id": "urn:li:share:99" } })],
    ]);
    const li = new LinkedInPublisher({ clientId: "id", clientSecret: "secret", fetch: fn, sleep: async () => {} });

    const out = await li.publish(account, {
      target: { platform: "linkedin", format: "feed_video" },
      rendition: { platform: "linkedin", format: "feed_video", caption: "New project", hashtags: ["AI"], title: null, linkUrl: null },
      media: [{ kind: "video", mimeType: "video/mp4", sizeBytes: 10, publicUrl: "https://x", read: async () => bytes }],
    });

    expect(out.externalId).toBe("urn:li:share:99");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => (c.body as Uint8Array).length)).toEqual([6, 4]);
    const finalize = JSON.parse(calls.find((c) => c.url.includes("finalizeUpload"))!.body as string);
    expect(finalize.finalizeUploadRequest.uploadedPartIds).toEqual(["e1", "e2"]);
    const post = calls.find((c) => c.url.endsWith("/rest/posts"))!;
    expect(post.headers["LinkedIn-Version"]).toMatch(/^\d{6}$/);
    const body = JSON.parse(post.body as string);
    expect(body.author).toBe("urn:li:person:abc");
    expect(body.content.media.id).toBe("urn:li:video:v1");
    expect(body.lifecycleState).toBe("PUBLISHED");
  });

  it("creates a text post without media", async () => {
    const { fn, calls } = fakeFetch([
      ["POST", "/rest/posts", () => ({ json: {}, status: 201, headers: { "x-restli-id": "urn:li:share:1" } })],
    ]);
    const li = new LinkedInPublisher({ clientId: "id", clientSecret: "secret", fetch: fn });
    await li.publish(account, {
      target: { platform: "linkedin", format: "text" },
      rendition: { platform: "linkedin", format: "text", caption: "שלום", hashtags: [], title: null, linkUrl: null },
      media: [],
    });
    expect(JSON.parse(calls[0]!.body as string).content).toBeUndefined();
  });
});
