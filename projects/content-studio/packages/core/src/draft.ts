import { createHash, randomUUID } from "node:crypto";
import type { ContentFormat, PlatformId } from "./platforms.ts";
import type { ContentPlan } from "./plan.ts";

/**
 * A draft is one piece of content on its way from a brief to published posts.
 *
 * The one rule this module exists to enforce: nothing is published unless the
 * owner approved exactly the version that will go out. Approval is bound to a
 * revision hash over the captions and the rendered media; any change after
 * approval produces a new hash and needs a new approval.
 */

export type DraftStatus =
  | "planning"
  | "awaiting_assets"
  | "rendering"
  | "awaiting_approval"
  | "approved"
  | "publishing"
  | "published"
  | "partially_published"
  | "failed"
  | "cancelled";

export type Channel = "web" | "whatsapp" | "api";

export interface Target {
  platform: PlatformId;
  format: ContentFormat;
}

export interface Brief {
  text: string;
  targets: Target[];
  channel: Channel;
}

export interface Asset {
  id: string;
  /** Which asset request this answers; null for extra material the user sent unprompted. */
  requestId: string | null;
  kind: "image" | "video";
  mimeType: string;
  /** Storage key, resolved by the media store. */
  key: string;
  sha256: string;
  addedAt: string;
}

export interface MediaArtifact {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  key: string;
  sha256: string;
  width: number;
  height: number;
  durationSec: number | null;
  /** Aspect ratio label, e.g. "9:16". */
  aspect: string;
}

export interface Approval {
  revisionHash: string;
  approvedAt: string;
  via: Channel;
}

export type PublicationStatus = "pending" | "published" | "failed" | "skipped";

export interface Publication {
  platform: PlatformId;
  format: ContentFormat;
  status: PublicationStatus;
  externalId: string | null;
  url: string | null;
  error: string | null;
  at: string | null;
}

export interface HistoryEntry {
  at: string;
  event: DraftEvent["type"];
  from: DraftStatus;
  to: DraftStatus;
}

export interface Draft {
  id: string;
  ownerId: string;
  status: DraftStatus;
  brief: Brief;
  plan: ContentPlan | null;
  assets: Asset[];
  media: MediaArtifact[];
  /** Increments every time a new preview is produced. */
  revision: number;
  revisionHash: string | null;
  approval: Approval | null;
  feedback: { text: string; at: string }[];
  publications: Publication[];
  error: string | null;
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export type DraftEvent =
  | { type: "PLAN_READY"; plan: ContentPlan }
  | { type: "ASSET_ADDED"; asset: Asset }
  | { type: "RENDER_STARTED" }
  | { type: "RENDER_DONE"; media: MediaArtifact[] }
  | { type: "FEEDBACK"; text: string }
  | { type: "APPROVE"; revisionHash: string; via: Channel }
  | { type: "PUBLISH_STARTED" }
  | { type: "PUBLISH_RESULT"; publication: Publication }
  | { type: "PUBLISH_FINISHED" }
  | { type: "FAIL"; error: string }
  | { type: "CANCEL" };

export class InvalidTransitionError extends Error {
  readonly from: DraftStatus;
  readonly event: DraftEvent["type"];

  constructor(from: DraftStatus, event: DraftEvent["type"], reason?: string) {
    super(`Cannot apply ${event} while draft is ${from}${reason ? `: ${reason}` : ""}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.event = event;
  }
}

export class StaleApprovalError extends Error {
  constructor() {
    super("The approved version is no longer the current preview. Review the latest preview and approve again.");
    this.name = "StaleApprovalError";
  }
}

const TERMINAL: DraftStatus[] = ["published", "partially_published", "failed", "cancelled"];

export function isTerminal(status: DraftStatus): boolean {
  return TERMINAL.includes(status);
}

export function createDraft(input: { ownerId: string; brief: Brief; now?: Date }): Draft {
  const at = (input.now ?? new Date()).toISOString();
  if (input.brief.targets.length === 0) throw new Error("A draft needs at least one target platform");
  return {
    id: randomUUID(),
    ownerId: input.ownerId,
    status: "planning",
    brief: input.brief,
    plan: null,
    assets: [],
    media: [],
    revision: 0,
    revisionHash: null,
    approval: null,
    feedback: [],
    publications: [],
    error: null,
    history: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** Required asset requests that have no asset yet. */
export function missingAssets(draft: Draft): string[] {
  if (!draft.plan) return [];
  const answered = new Set(draft.assets.map((a) => a.requestId).filter(Boolean));
  return draft.plan.assetRequests.filter((r) => r.required && !answered.has(r.id)).map((r) => r.id);
}

/**
 * Hash over everything that will be published: renditions (captions, hashtags,
 * titles, links) and the bytes of the rendered media. Stable key order.
 */
export function computeRevisionHash(plan: ContentPlan, media: MediaArtifact[]): string {
  const payload = {
    renditions: plan.renditions.map((r) => ({
      platform: r.platform,
      format: r.format,
      caption: r.caption,
      hashtags: r.hashtags,
      title: r.title,
      linkUrl: r.linkUrl,
    })),
    media: media.map((m) => ({ kind: m.kind, sha256: m.sha256, aspect: m.aspect })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Pure state transition. Returns a new draft; never mutates the input.
 * Throws InvalidTransitionError or StaleApprovalError.
 */
export function transition(draft: Draft, event: DraftEvent, now: Date = new Date()): Draft {
  const at = now.toISOString();
  const from = draft.status;
  const reject = (reason?: string): never => {
    throw new InvalidTransitionError(from, event.type, reason);
  };

  if (isTerminal(from)) reject("draft is finished");

  let next: Draft = { ...draft };

  switch (event.type) {
    case "PLAN_READY": {
      if (from !== "planning") reject();
      next.plan = event.plan;
      next.status = missingAssets(next).length > 0 ? "awaiting_assets" : "rendering";
      break;
    }
    case "ASSET_ADDED": {
      if (!["awaiting_assets", "awaiting_approval", "planning"].includes(from)) reject();
      next.assets = [...draft.assets, event.asset];
      if (from === "awaiting_assets" && missingAssets(next).length === 0) next.status = "rendering";
      // A new asset while awaiting approval invalidates the preview: re-render.
      if (from === "awaiting_approval") {
        next.status = "rendering";
        next.approval = null;
      }
      break;
    }
    case "RENDER_STARTED": {
      if (from !== "rendering") reject();
      break;
    }
    case "RENDER_DONE": {
      if (from !== "rendering") reject();
      if (!draft.plan) reject("no plan");
      next.media = event.media;
      next.revision = draft.revision + 1;
      next.revisionHash = computeRevisionHash(draft.plan as ContentPlan, event.media);
      next.approval = null;
      next.status = "awaiting_approval";
      break;
    }
    case "FEEDBACK": {
      if (!["awaiting_approval", "awaiting_assets"].includes(from)) reject();
      next.feedback = [...draft.feedback, { text: event.text, at }];
      next.approval = null;
      next.status = "planning";
      break;
    }
    case "APPROVE": {
      if (from !== "awaiting_approval") reject();
      if (!draft.revisionHash || event.revisionHash !== draft.revisionHash) throw new StaleApprovalError();
      next.approval = { revisionHash: event.revisionHash, approvedAt: at, via: event.via };
      next.status = "approved";
      break;
    }
    case "PUBLISH_STARTED": {
      if (from !== "approved") reject("publishing requires an approval");
      if (!draft.approval || draft.approval.revisionHash !== draft.revisionHash) throw new StaleApprovalError();
      next.publications = draft.brief.targets.map((t) => ({
        platform: t.platform,
        format: t.format,
        status: "pending",
        externalId: null,
        url: null,
        error: null,
        at: null,
      }));
      next.status = "publishing";
      break;
    }
    case "PUBLISH_RESULT": {
      if (from !== "publishing") reject();
      const p = event.publication;
      const idx = draft.publications.findIndex((x) => x.platform === p.platform && x.format === p.format);
      if (idx === -1) reject(`unknown target ${p.platform}:${p.format}`);
      next.publications = draft.publications.map((x, i) => (i === idx ? p : x));
      break;
    }
    case "PUBLISH_FINISHED": {
      if (from !== "publishing") reject();
      const statuses = draft.publications.map((p) => p.status);
      if (statuses.includes("pending")) reject("some targets have no result yet");
      const ok = statuses.filter((s) => s === "published").length;
      next.status = ok === statuses.length ? "published" : ok === 0 ? "failed" : "partially_published";
      if (ok === 0) next.error = "No target was published";
      break;
    }
    case "FAIL": {
      next.error = event.error;
      next.status = "failed";
      break;
    }
    case "CANCEL": {
      if (from === "publishing") reject("already publishing");
      next.status = "cancelled";
      break;
    }
  }

  next.updatedAt = at;
  next.history = [...draft.history, { at, event: event.type, from, to: next.status }];
  return next;
}
