import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  StaleApprovalError,
  createDraft,
  missingAssets,
  transition,
  type Asset,
  type Draft,
} from "../src/index.ts";
import { samplePlan, sampleVideo } from "./fixtures.ts";

const brief = {
  text: "סטורי על השקת הפרויקט",
  channel: "whatsapp" as const,
  targets: [
    { platform: "instagram" as const, format: "story" as const },
    { platform: "linkedin" as const, format: "feed_video" as const },
  ],
};

const photo: Asset = {
  id: "a1",
  requestId: "photo-1",
  kind: "image",
  mimeType: "image/jpeg",
  key: "k",
  sha256: "s",
  addedAt: new Date().toISOString(),
};

function toPreview(): Draft {
  let d = createDraft({ ownerId: "owner", brief });
  d = transition(d, { type: "PLAN_READY", plan: samplePlan() });
  d = transition(d, { type: "ASSET_ADDED", asset: photo });
  return transition(d, { type: "RENDER_DONE", media: [sampleVideo()] });
}

describe("draft lifecycle", () => {
  it("waits for required photos before rendering", () => {
    let d = createDraft({ ownerId: "owner", brief });
    d = transition(d, { type: "PLAN_READY", plan: samplePlan() });
    expect(d.status).toBe("awaiting_assets");
    expect(missingAssets(d)).toEqual(["photo-1"]);

    d = transition(d, { type: "ASSET_ADDED", asset: photo });
    expect(d.status).toBe("rendering");
  });

  it("skips the asset step when the plan needs no photos", () => {
    let d = createDraft({ ownerId: "owner", brief });
    d = transition(d, { type: "PLAN_READY", plan: samplePlan({ assetRequests: [] }) });
    expect(d.status).toBe("rendering");
  });

  it("produces a preview with a revision hash", () => {
    const d = toPreview();
    expect(d.status).toBe("awaiting_approval");
    expect(d.revision).toBe(1);
    expect(d.revisionHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("publishes only after approving the current revision", () => {
    let d = toPreview();
    expect(() => transition(d, { type: "PUBLISH_STARTED" })).toThrow(InvalidTransitionError);
    expect(() => transition(d, { type: "APPROVE", revisionHash: "0000000000000000", via: "web" })).toThrow(
      StaleApprovalError,
    );

    d = transition(d, { type: "APPROVE", revisionHash: d.revisionHash!, via: "whatsapp" });
    expect(d.status).toBe("approved");
    d = transition(d, { type: "PUBLISH_STARTED" });
    expect(d.publications.map((p) => p.status)).toEqual(["pending", "pending"]);
  });

  it("a changed caption needs a new approval", () => {
    const first = toPreview();
    let d = transition(first, { type: "FEEDBACK", text: "תקצר את הטקסט" });
    expect(d.status).toBe("planning");
    const revised = samplePlan();
    revised.renditions[1]!.caption = "משיק היום";
    d = transition(d, { type: "PLAN_READY", plan: revised });
    d = transition(d, { type: "RENDER_DONE", media: [sampleVideo()] });
    expect(d.revision).toBe(2);
    expect(d.revisionHash).not.toBe(first.revisionHash);
    expect(() => transition(d, { type: "APPROVE", revisionHash: first.revisionHash!, via: "web" })).toThrow(
      StaleApprovalError,
    );
  });

  it("reports partial success", () => {
    let d = toPreview();
    d = transition(d, { type: "APPROVE", revisionHash: d.revisionHash!, via: "web" });
    d = transition(d, { type: "PUBLISH_STARTED" });
    d = transition(d, {
      type: "PUBLISH_RESULT",
      publication: { platform: "instagram", format: "story", status: "published", externalId: "1", url: null, error: null, at: null },
    });
    expect(() => transition(d, { type: "PUBLISH_FINISHED" })).toThrow(InvalidTransitionError);
    d = transition(d, {
      type: "PUBLISH_RESULT",
      publication: { platform: "linkedin", format: "feed_video", status: "failed", externalId: null, url: null, error: "token expired", at: null },
    });
    d = transition(d, { type: "PUBLISH_FINISHED" });
    expect(d.status).toBe("partially_published");
  });

  it("does not move once finished", () => {
    const d = transition(toPreview(), { type: "CANCEL" });
    expect(d.status).toBe("cancelled");
    expect(() => transition(d, { type: "FEEDBACK", text: "x" })).toThrow(InvalidTransitionError);
  });

  it("does not mutate the previous draft", () => {
    const d = toPreview();
    const snapshot = JSON.stringify(d);
    transition(d, { type: "APPROVE", revisionHash: d.revisionHash!, via: "web" });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});
