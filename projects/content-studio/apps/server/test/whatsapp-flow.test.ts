import { afterEach, describe, expect, it } from "vitest";
import { detectTargets } from "../src/channels/conversation.ts";
import { OWNER, setup } from "./harness.ts";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(() => ctx?.cleanup());

const text = (id: string, body: string, from = OWNER) => ({ id, from, type: "text", text: { body } });
const kinds = () => ctx.waSent.map((m) => m.body.type);

describe("WhatsApp channel", () => {
  it("verifies the webhook subscription", async () => {
    ctx = await setup({ whatsapp: true });
    const ok = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
    expect(ok.body).toBe("42");
    const bad = await ctx.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects unsigned payloads and ignores strangers", async () => {
    ctx = await setup({ whatsapp: true });
    expect((await ctx.webhook([text("m1", "פרסם משהו")], false)).statusCode).toBe(401);
    expect((await ctx.webhook([text("m2", "פרסם משהו", "972599999999")])).statusCode).toBe(200);
    await ctx.settle();
    expect(ctx.store.listDrafts("owner")).toHaveLength(0);
    expect(ctx.waSent).toHaveLength(0);
  });

  it("brief → photo → preview with buttons → approve from the button", async () => {
    ctx = await setup({ whatsapp: true });
    await ctx.store.saveAccount("owner", await ctx.instagram.completeAuthorization());

    await ctx.webhook([text("m1", "תעשה לי סטורי באינסטגרם על ההשקה של הסטודיו")]);
    await ctx.settle();
    const draft = ctx.store.listDrafts("owner")[0]!;
    expect(draft.brief.targets).toEqual([{ platform: "instagram", format: "story" }]);
    expect(draft.status).toBe("awaiting_assets");
    expect(ctx.waSent.at(-1)!.body.text.body).toContain("אני צריך ממך");

    // Same message delivered twice: handled once.
    await ctx.webhook([text("m1", "תעשה לי סטורי באינסטגרם על ההשקה של הסטודיו")]);
    await ctx.settle();
    expect(ctx.store.listDrafts("owner")).toHaveLength(1);

    await ctx.webhook([{ id: "m2", from: OWNER, type: "image", image: { id: "media-123", mime_type: "image/jpeg" } }]);
    await ctx.settle();
    const previewed = ctx.store.getDraft(draft.id)!;
    expect(previewed.status).toBe("awaiting_approval");
    expect(kinds().slice(-3)).toEqual(["video", "text", "interactive"]);
    const buttons = ctx.waSent.at(-1)!.body.interactive.action.buttons;
    expect(buttons.map((b: any) => b.reply.title.length <= 20)).toEqual([true, true, true]);
    const approveId = buttons[0].reply.id as string;
    expect(approveId).toBe(`approve:${draft.id}:${previewed.revisionHash}`);

    await ctx.webhook([{ id: "m3", from: OWNER, type: "interactive", interactive: { type: "button_reply", button_reply: { id: approveId, title: "✅" } } }]);
    await ctx.settle();
    expect(ctx.store.getDraft(draft.id)!.status).toBe("published");
    expect(ctx.instagram.records).toHaveLength(1);
    expect(ctx.waSent.at(-1)!.body.text.body).toContain("Instagram");
  });

  it("treats text during a preview as feedback, and an old approve button as stale", async () => {
    ctx = await setup({ whatsapp: true });
    await ctx.webhook([text("m1", "סטורי על הכנס")]);
    await ctx.settle();
    await ctx.webhook([{ id: "m2", from: OWNER, type: "image", image: { id: "media-123", mime_type: "image/jpeg" } }]);
    await ctx.settle();
    const v1 = ctx.store.listDrafts("owner")[0]!;
    const oldButton = `approve:${v1.id}:${v1.revisionHash}`;

    await ctx.webhook([text("m3", "תוסיף את התאריך")]);
    await ctx.settle();
    const v2 = ctx.store.getDraft(v1.id)!;
    expect(v2.revision).toBe(2);
    expect(v2.feedback.map((f) => f.text)).toEqual(["תוסיף את התאריך"]);

    await ctx.webhook([{ id: "m4", from: OWNER, type: "interactive", interactive: { type: "button_reply", button_reply: { id: oldButton, title: "✅" } } }]);
    await ctx.settle();
    expect(ctx.store.getDraft(v1.id)!.status).toBe("awaiting_approval");
    expect(ctx.waSent.at(-1)!.body.text.body).toContain("כבר לא העדכנית");
  });

  it("a photo with a caption starts a draft with that photo", async () => {
    ctx = await setup({ whatsapp: true });
    await ctx.webhook([{ id: "m1", from: OWNER, type: "image", image: { id: "media-123", mime_type: "image/jpeg", caption: "פוסט ללינקדאין על היום הראשון" } }]);
    await ctx.settle();
    const draft = ctx.store.listDrafts("owner")[0]!;
    expect(draft.brief.targets).toEqual([{ platform: "linkedin", format: "feed_video" }]);
    expect(draft.assets.map((a) => a.requestId)).toEqual(["owner-1"]);
    // The photo is used directly: no request for another one, straight to the preview.
    expect(draft.status).toBe("awaiting_approval");
    expect(draft.plan!.storyboard.scenes[0]!.assetRequestId).toBe("owner-1");
  });
});

describe("detectTargets", () => {
  const defaults = [{ platform: "instagram" as const, format: "story" as const }];
  it("reads networks from Hebrew and English", () => {
    expect(detectTargets("סטורי באינסטגרם ופוסט בלינקדאין", defaults, [])).toEqual([
      { platform: "instagram", format: "story" },
      { platform: "linkedin", format: "feed_video" },
    ]);
    expect(detectTargets("a reel for instagram", defaults, [])).toEqual([{ platform: "instagram", format: "reel" }]);
    expect(detectTargets("משהו על החופשה", defaults, [])).toEqual(defaults);
    expect(detectTargets("תפרסם בכל הרשתות", defaults, ["instagram", "linkedin"]).map((t) => t.platform)).toEqual(["instagram", "linkedin"]);
  });
});
