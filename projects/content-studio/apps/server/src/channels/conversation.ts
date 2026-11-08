import {
  InvalidTransitionError,
  StaleApprovalError,
  listPlatforms,
  missingAssets,
  type ContentFormat,
  type Draft,
  type PlatformId,
  type Target,
} from "@studio/core";
import { statusLabel, t } from "../messages.ts";
import type { Studio } from "../studio.ts";
import type { InboundMessage } from "./whatsapp.ts";

/** Read access to the owner's state. */
export interface ConversationContext {
  activeDraft(): Draft | undefined;
  linkedPlatforms(): PlatformId[];
}

/** What the conversation needs from the outside world. */
export interface ConversationIO {
  reply(text: string): Promise<void>;
  download(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** Lines describing linked accounts and links to connect the rest. */
  accountsSummary(): string[];
}

const KEYWORDS: [RegExp, PlatformId, ContentFormat][] = [
  [/(רילס?|reels?)/i, "instagram", "reel"],
  [/(אינסטגרם|אינסטה|instagram|insta)/i, "instagram", "story"],
  [/(לינקדאין|לינקדין|linkedin)/i, "linkedin", "feed_video"],
  [/(פייסבוק|facebook)/i, "facebook", "reel"],
  [/(טיקטוק|tiktok)/i, "tiktok", "short"],
  [/(יוטיוב|youtube|shorts)/i, "youtube", "short"],
  [/(טוויטר|twitter|\bx\b)/i, "x", "feed_video"],
  [/(ת'רדס|תרדס|threads)/i, "threads", "feed_video"],
];
const EVERYWHERE = /(בכל מקום|בכל הרשתות|כל הרשתות|everywhere|all networks)/i;

/**
 * Works out where to publish from the owner's words ("סטורי באינסטגרם ופוסט
 * בלינקדאין"). Falls back to the configured defaults when no network is named.
 */
export function detectTargets(text: string, defaults: Target[], linked: PlatformId[]): Target[] {
  if (EVERYWHERE.test(text) && linked.length) {
    return linked.map((p) => defaults.find((d) => d.platform === p) ?? { platform: p, format: listPlatforms().find((x) => x.id === p)!.formats[0]!.format });
  }
  const found: Target[] = [];
  for (const [re, platform, format] of KEYWORDS) {
    if (re.test(text) && !found.some((f) => f.platform === platform)) found.push({ platform, format });
  }
  return found.length ? found : defaults;
}

const NEW = /^\s*(חדש|new)\s*[:：-]\s*/i;
const CANCEL = /^\s*(בטל|ביטול|cancel|stop)\s*$/i;
const STATUS = /^\s*(סטטוס|מצב|status)\s*\??\s*$/i;
const ACCOUNTS = /^\s*(חשבונות|חיבורים|accounts|connect)\s*$/i;

/**
 * The WhatsApp conversation with the owner. Free text starts a new piece or,
 * while a preview is waiting, counts as feedback on it. Photos go to the
 * draft that asked for them. Buttons approve, edit or cancel a preview.
 */
export class Conversation {
  private readonly studio: Studio;
  private readonly defaults: Target[];
  /** Photos sent before any brief: attached to the next draft. */
  private held: { bytes: Uint8Array; mimeType: string }[] = [];

  constructor(studio: Studio, defaults: Target[]) {
    this.studio = studio;
    this.defaults = defaults;
  }

  async handle(msg: InboundMessage, io: ConversationIO, ctx: ConversationContext): Promise<void> {
    try {
      await this.dispatch(msg, io, ctx);
    } catch (err) {
      if (err instanceof StaleApprovalError) return io.reply(t.stale);
      if (err instanceof InvalidTransitionError) {
        const active = ctx.activeDraft();
        return io.reply(active ? t.busy(active) : t.nothingActive);
      }
      throw err;
    }
  }

  private async dispatch(msg: InboundMessage, io: ConversationIO, ctx: ConversationContext): Promise<void> {
    const active = ctx.activeDraft();

    if (msg.type === "button") {
      const [action, draftId, hash] = msg.buttonId.split(":");
      if (!draftId) return;
      if (action === "approve" && hash) {
        await this.studio.approve(draftId, hash, "whatsapp");
        return io.reply(t.publishing);
      }
      if (action === "edit") return io.reply(t.askEdit);
      if (action === "cancel") {
        await this.studio.cancel(draftId);
        return io.reply(t.cancelled);
      }
      return;
    }

    if (msg.type === "media") {
      const file = await io.download(msg.mediaId);
      if (active && ["planning", "awaiting_assets", "awaiting_approval"].includes(active.status)) {
        const draft = await this.studio.addAsset(active.id, file);
        return io.reply(t.assetReceived(draft.status === "rendering" ? 0 : missingAssets(draft).length));
      }
      if (msg.caption?.trim()) return this.startDraft(msg.caption, [file], io, ctx);
      this.held.push(file);
      return io.reply(t.assetHeld);
    }

    if (msg.type !== "text") return;
    const text = msg.text.trim();
    if (!text) return;

    if (ACCOUNTS.test(text)) return io.reply(t.accounts(io.accountsSummary()));
    if (STATUS.test(text)) return io.reply(active ? t.status(active) : t.nothingActive);
    if (CANCEL.test(text)) {
      if (!active) return io.reply(t.nothingActive);
      await this.studio.cancel(active.id);
      return io.reply(t.cancelled);
    }
    if (NEW.test(text)) return this.startDraft(text.replace(NEW, ""), [], io, ctx);

    if (active?.status === "awaiting_approval" || active?.status === "awaiting_assets") {
      await this.studio.feedback(active.id, text);
      return io.reply(t.revising);
    }
    if (active) return io.reply(t.busy(active));
    return this.startDraft(text, [], io, ctx);
  }

  private async startDraft(text: string, files: { bytes: Uint8Array; mimeType: string }[], io: ConversationIO, ctx: ConversationContext): Promise<void> {
    const targets = detectTargets(text, this.defaults, ctx.linkedPlatforms());
    const assets = [...this.held, ...files];
    this.held = [];
    await this.studio.createDraft({ text, targets, channel: "whatsapp" }, assets);
    await io.reply(`${t.received}\n(${targets.map((x) => `${x.platform}:${x.format}`).join(", ")} · ${statusLabel("planning")})`);
  }
}
