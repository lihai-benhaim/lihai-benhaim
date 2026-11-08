import { afterEach, describe, expect, it } from "vitest";
import { multipart, setup } from "./harness.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(() => ctx?.cleanup());

async function linkViaOAuth(platform: string) {
  const start = await ctx.app.inject({ method: "POST", url: `/api/connect/${platform}`, headers: ctx.auth });
  const url = new URL(start.json().url);
  const cb = await ctx.app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe(`/?linked=${platform}`);
}

describe("web studio flow", () => {
  it("rejects API calls without the admin token", async () => {
    ctx = await setup();
    const res = await ctx.app.inject({ method: "GET", url: "/api/drafts" });
    expect(res.statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
  });

  it("brief → photo → preview → approve → publish", async () => {
    ctx = await setup();
    await linkViaOAuth("instagram");
    expect(ctx.store.getAccount("owner", "instagram")?.displayName).toContain("Dry run");

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/drafts",
      headers: ctx.auth,
      payload: { text: "סטורי על השקת הפרויקט", targets: ["instagram:story", "linkedin:feed_video"] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await ctx.settle();
    expect(ctx.store.getDraft(id)?.status).toBe("awaiting_assets");
    expect(ctx.recorder.events.map((e) => e.type)).toEqual(["assetsNeeded"]);

    const upload = multipart(new Uint8Array([0xff, 0xd8, 0xff, 0]), "image/jpeg");
    const up = await ctx.app.inject({ method: "POST", url: `/api/drafts/${id}/assets`, headers: { ...ctx.auth, ...upload.headers }, payload: upload.payload });
    expect(up.statusCode).toBe(200);
    await ctx.settle();

    const draft = ctx.store.getDraft(id)!;
    expect(draft.status).toBe("awaiting_approval");
    const preview = ctx.recorder.events.find((e) => e.type === "preview")!;
    expect(preview.report!.unlinked).toEqual(["LinkedIn"]);
    expect(preview.report!.mediaUrls.map((m) => m.aspect)).toEqual(["9:16", "4:5"]);

    // Signed media: valid link works, tampered link does not, ranges are honoured.
    const mediaUrl = new URL(preview.report!.mediaUrls[0]!.url);
    const path = `${mediaUrl.pathname}${mediaUrl.search}`;
    expect((await ctx.app.inject({ method: "GET", url: path })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: path.replace(/sig=[^&]+/, "sig=forged") })).statusCode).toBe(403);
    const partial = await ctx.app.inject({ method: "GET", url: path, headers: { range: "bytes=0-4" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("video");

    const stale = await ctx.app.inject({ method: "POST", url: `/api/drafts/${id}/approve`, headers: ctx.auth, payload: { revisionHash: "0000" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("stale_approval");
    expect(ctx.instagram.records).toHaveLength(0);

    const ok = await ctx.app.inject({ method: "POST", url: `/api/drafts/${id}/approve`, headers: ctx.auth, payload: { revisionHash: draft.revisionHash } });
    expect(ok.statusCode).toBe(200);
    await ctx.settle();

    const done = ctx.store.getDraft(id)!;
    expect(done.status).toBe("partially_published");
    expect(done.publications.find((p) => p.platform === "instagram")?.status).toBe("published");
    expect(done.publications.find((p) => p.platform === "linkedin")?.error).toBe("account not linked");
    expect(ctx.instagram.records).toHaveLength(1);
    expect(ctx.instagram.records[0]!.request.media[0]!.publicUrl).toMatch(/^https:\/\/studio\.test\/media\/drafts\/.+\?exp=\d+&sig=/);
  });

  it("feedback produces a new version that needs its own approval", async () => {
    ctx = await setup();
    const created = await ctx.app.inject({ method: "POST", url: "/api/drafts", headers: ctx.auth, payload: { text: "פוסט על כנס", targets: ["instagram:story"] } });
    const id = created.json().id as string;
    await ctx.settle();
    await ctx.studio.addAsset(id, { bytes: new Uint8Array([1]), mimeType: "image/jpeg" });
    await ctx.settle();
    const first = ctx.store.getDraft(id)!;

    await ctx.app.inject({ method: "POST", url: `/api/drafts/${id}/feedback`, headers: ctx.auth, payload: { text: "יותר קצר" } });
    await ctx.settle();
    const second = ctx.store.getDraft(id)!;
    expect(second.status).toBe("awaiting_approval");
    expect(second.revision).toBe(2);
    expect(second.revisionHash).not.toBe(first.revisionHash);

    const res = await ctx.app.inject({ method: "POST", url: `/api/drafts/${id}/approve`, headers: ctx.auth, payload: { revisionHash: first.revisionHash } });
    expect(res.statusCode).toBe(409);
  });
});
