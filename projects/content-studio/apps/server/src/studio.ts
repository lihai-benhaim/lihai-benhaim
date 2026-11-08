import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  InvalidTransitionError,
  StaleApprovalError,
  createDraft,
  getPlatform,
  mediaForTarget,
  missingAssets,
  transition,
  validateRendition,
  type Asset,
  type Brief,
  type Channel,
  type Draft,
  type DraftEvent,
  type MediaArtifact,
  type Publication,
  type ValidationIssue,
} from "@studio/core";
import type { BrandProfile, ContentPlanner } from "@studio/agent";
import type { MediaRenderer } from "@studio/media";
import type { PublishMedia, PublisherRegistry } from "@studio/publishers";
import { extensionFor, type MediaStore } from "./media-store.ts";
import type { StateStore } from "./store.ts";

/** Where the studio reports progress. WhatsApp in production, a recorder in tests. */
export interface Notifier {
  assetsNeeded(draft: Draft): Promise<void>;
  preview(draft: Draft, report: PreviewReport): Promise<void>;
  published(draft: Draft): Promise<void>;
  failed(draft: Draft): Promise<void>;
}

export interface PreviewReport {
  issues: ValidationIssue[];
  /** Display names of target platforms with no linked account. */
  unlinked: string[];
  /** Signed URLs of the rendered media, for previews. */
  mediaUrls: { kind: "image" | "video"; url: string; aspect: string }[];
}

export interface StudioDeps {
  ownerId: string;
  brand: BrandProfile;
  store: StateStore;
  media: MediaStore;
  planner: ContentPlanner;
  renderer: MediaRenderer;
  publishers: PublisherRegistry;
  notifier: Notifier;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * Runs drafts through the pipeline:
 *   brief → plan (Claude) → photos from the owner → render → preview
 *   → approval of that exact version → publish to each linked network.
 *
 * Long steps (planning, rendering, publishing) run in the background and never
 * hold the draft lock; state changes go through `update`, which serialises
 * read-modify-write per draft and applies the core state machine.
 */
export class Studio {
  private readonly d: StudioDeps;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly running = new Set<Promise<unknown>>();

  constructor(deps: StudioDeps) {
    this.d = deps;
  }

  get ownerId(): string {
    return this.d.ownerId;
  }

  // ---- commands -------------------------------------------------------------

  async createDraft(brief: Brief, initialAssets: { bytes: Uint8Array; mimeType: string }[] = []): Promise<Draft> {
    let draft = createDraft({ ownerId: this.d.ownerId, brief });
    for (const a of initialAssets) {
      draft = transition(draft, { type: "ASSET_ADDED", asset: await this.storeAsset(draft.id, a, ownerAssetId(draft)) });
    }
    await this.d.store.saveDraft(draft);
    this.background(draft.id, () => this.runPlanning(draft.id));
    return draft;
  }

  async addAsset(draftId: string, file: { bytes: Uint8Array; mimeType: string; requestId?: string | null }): Promise<Draft> {
    const current = this.require(draftId);
    // Answer the first open photo request; otherwise keep it as the owner's own material ("owner-N"),
    // which the planner can place in a scene directly.
    const requestId = file.requestId ?? missingAssets(current)[0] ?? ownerAssetId(current);
    const asset = await this.storeAsset(draftId, file, requestId);
    const draft = await this.update(draftId, { type: "ASSET_ADDED", asset });
    if (draft.status === "rendering") this.background(draftId, () => this.runRender(draftId));
    return draft;
  }

  async feedback(draftId: string, text: string): Promise<Draft> {
    const draft = await this.update(draftId, { type: "FEEDBACK", text });
    this.background(draftId, () => this.runPlanning(draftId));
    return draft;
  }

  /** Approves the exact preview identified by revisionHash, then publishes. */
  async approve(draftId: string, revisionHash: string, via: Channel): Promise<Draft> {
    const draft = await this.update(draftId, { type: "APPROVE", revisionHash, via });
    this.background(draftId, () => this.runPublish(draftId));
    return draft;
  }

  cancel(draftId: string): Promise<Draft> {
    return this.update(draftId, { type: "CANCEL" });
  }

  /** Validation issues and account status for the current preview. */
  report(draft: Draft): PreviewReport {
    const issues: ValidationIssue[] = [];
    const unlinked: string[] = [];
    for (const target of draft.brief.targets) {
      const rendition = draft.plan?.renditions.find((r) => r.platform === target.platform && r.format === target.format);
      if (rendition) issues.push(...validateRendition(rendition, mediaForTarget(target, draft.media)));
      if (!this.d.store.getAccount(this.d.ownerId, target.platform) || !this.d.publishers.get(target.platform)) {
        unlinked.push(getPlatform(target.platform).displayName);
      }
    }
    const mediaUrls = draft.media.map((m) => ({ kind: m.kind, url: this.d.media.publicUrl(m.key), aspect: m.aspect }));
    return { issues, unlinked: [...new Set(unlinked)], mediaUrls };
  }

  /** Resolves when all background work has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  // ---- pipeline steps -------------------------------------------------------

  private async runPlanning(draftId: string): Promise<void> {
    const snapshot = this.require(draftId);
    const assets = await Promise.all(
      snapshot.assets.map(async (a) => ({ requestId: a.requestId, kind: a.kind, mimeType: a.mimeType, data: await this.d.media.read(a.key) })),
    );
    const plan = await this.d.planner.plan({
      brief: snapshot.brief,
      brand: this.d.brand,
      assets,
      previousPlan: snapshot.plan,
      feedback: snapshot.feedback.map((f) => f.text),
    });
    const draft = await this.update(draftId, { type: "PLAN_READY", plan });
    if (draft.status === "awaiting_assets") await this.d.notifier.assetsNeeded(draft);
    else if (draft.status === "rendering") await this.runRender(draftId);
  }

  private async runRender(draftId: string): Promise<void> {
    const snapshot = this.require(draftId);
    if (!snapshot.plan) throw new Error("render without a plan");
    const outDir = this.d.media.path(`drafts/${draftId}/rev-${snapshot.revision + 1}`);
    const files = await this.d.renderer.render({
      plan: snapshot.plan,
      assets: snapshot.assets
        .filter((a): a is Asset & { requestId: string } => a.requestId !== null)
        .map((a) => ({ requestId: a.requestId, kind: a.kind, path: this.d.media.path(a.key) })),
      outDir,
    });
    const media: MediaArtifact[] = files.map((f) => ({
      id: randomUUID(),
      kind: f.kind,
      mimeType: f.mimeType,
      key: this.d.media.keyFor(f.path),
      sha256: f.sha256,
      width: f.width,
      height: f.height,
      durationSec: f.durationSec,
      aspect: f.aspect,
    }));
    const draft = await this.update(draftId, { type: "RENDER_DONE", media });
    await this.d.notifier.preview(draft, this.report(draft));
  }

  private async runPublish(draftId: string): Promise<void> {
    let draft = await this.update(draftId, { type: "PUBLISH_STARTED" });
    for (const target of draft.brief.targets) {
      const publication = await this.publishOne(draft, target);
      draft = await this.update(draftId, { type: "PUBLISH_RESULT", publication });
    }
    draft = await this.update(draftId, { type: "PUBLISH_FINISHED" });
    await this.d.notifier.published(draft);
  }

  private async publishOne(draft: Draft, target: Brief["targets"][number]): Promise<Publication> {
    const base = { platform: target.platform, format: target.format, externalId: null, url: null, at: new Date().toISOString() };
    const fail = (error: string): Publication => ({ ...base, status: "failed", error });

    const rendition = draft.plan?.renditions.find((r) => r.platform === target.platform && r.format === target.format);
    if (!rendition) return fail("no rendition in the plan");
    const publisher = this.d.publishers.get(target.platform);
    if (!publisher) return fail("this network is not supported yet");
    const account = this.d.store.getAccount(this.d.ownerId, target.platform);
    if (!account) return fail("account not linked");

    const media = mediaForTarget(target, draft.media);
    const errors = validateRendition(rendition, media).filter((i) => i.severity === "error");
    if (errors.length) return fail(errors.map((e) => e.message).join("; "));

    const publishMedia: PublishMedia[] = media.map((m) => ({
      kind: m.kind,
      mimeType: m.mimeType,
      sizeBytes: 0,
      publicUrl: this.d.media.publicUrl(m.key, 6 * 3600),
      read: () => this.d.media.read(m.key),
    }));
    try {
      const out = await publisher.publish(account, { target, rendition, media: publishMedia });
      return { ...base, status: "published", externalId: out.externalId, url: out.url, error: null };
    } catch (err) {
      this.d.log?.(`publish to ${target.platform} failed`, err);
      return fail((err as Error).message);
    }
  }

  // ---- plumbing -------------------------------------------------------------

  private async storeAsset(draftId: string, file: { bytes: Uint8Array; mimeType: string }, requestId: string | null): Promise<Asset> {
    const id = randomUUID();
    const kind = file.mimeType.startsWith("video/") ? "video" : "image";
    const stored = await this.d.media.put(join("drafts", draftId, "assets", `${id}.${extensionFor(file.mimeType)}`), file.bytes);
    return { id, requestId, kind, mimeType: file.mimeType, key: stored.key, sha256: stored.sha256, addedAt: new Date().toISOString() };
  }

  private require(draftId: string): Draft {
    const draft = this.d.store.getDraft(draftId);
    if (!draft || draft.ownerId !== this.d.ownerId) throw new NotFoundError(draftId);
    return draft;
  }

  /** Serialised read → transition → save for one draft. */
  private update(draftId: string, event: DraftEvent): Promise<Draft> {
    const prev = this.locks.get(draftId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const draft = transition(this.require(draftId), event);
      await this.d.store.saveDraft(draft);
      return draft;
    });
    this.locks.set(draftId, next);
    return next;
  }

  /** Runs a pipeline step in the background; a crash fails the draft and tells the owner. */
  private background(draftId: string, step: () => Promise<void>): void {
    const task = step().catch(async (err: unknown) => {
      if (err instanceof InvalidTransitionError || err instanceof StaleApprovalError) {
        // The draft moved on (cancelled, revised) while this step ran. Nothing to do.
        this.d.log?.(`step for ${draftId} superseded: ${(err as Error).message}`);
        return;
      }
      this.d.log?.(`draft ${draftId} failed`, err);
      try {
        const draft = await this.update(draftId, { type: "FAIL", error: (err as Error).message });
        await this.d.notifier.failed(draft);
      } catch (inner) {
        this.d.log?.(`could not record failure for ${draftId}`, inner);
      }
    });
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }
}

/** Id for a photo the owner sent without being asked: owner-1, owner-2, ... */
function ownerAssetId(draft: Draft): string {
  return `owner-${draft.assets.filter((a) => a.requestId?.startsWith("owner-")).length + 1}`;
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Draft ${id} not found`);
    this.name = "NotFoundError";
  }
}
