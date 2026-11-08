import { createHmac, timingSafeEqual } from "node:crypto";
import type { Draft } from "@studio/core";
import type { FetchLike } from "@studio/publishers";
import { previewText, publishReport, t } from "../messages.ts";
import type { Notifier, PreviewReport } from "../studio.ts";

/**
 * WhatsApp Business Cloud API: sending messages and reading webhooks.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Free-form messages can be sent only within 24 hours of the owner's last
 * message. Since the owner starts every conversation, previews and reports
 * normally fall inside that window (docs/platforms.md has the details).
 */
export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  graphVersion: string;
  fetch?: FetchLike;
}

export type InboundMessage =
  | { id: string; from: string; type: "text"; text: string }
  | { id: string; from: string; type: "media"; kind: "image" | "video"; mediaId: string; mimeType: string; caption: string | null }
  | { id: string; from: string; type: "button"; buttonId: string }
  | { id: string; from: string; type: "unsupported"; original: string };

export class WhatsAppClient {
  private readonly cfg: WhatsAppConfig;
  private readonly fetchFn: FetchLike;

  constructor(cfg: WhatsAppConfig) {
    this.cfg = cfg;
    this.fetchFn = cfg.fetch ?? fetch;
  }

  private get base(): string {
    return `https://graph.facebook.com/${this.cfg.graphVersion}`;
  }

  /** Checks X-Hub-Signature-256 against the raw request body. */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=")) return false;
    const expected = Buffer.from(`sha256=${createHmac("sha256", this.cfg.appSecret).update(rawBody, "utf8").digest("hex")}`);
    const given = Buffer.from(header);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  sendText(to: string, body: string): Promise<void> {
    return this.send(to, { type: "text", text: { body, preview_url: true } });
  }

  sendMedia(to: string, kind: "image" | "video", link: string, caption?: string): Promise<void> {
    return this.send(to, { type: kind, [kind]: { link, ...(caption ? { caption } : {}) } });
  }

  sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<void> {
    return this.send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  }

  /** Downloads media the owner sent (two steps: resolve URL, then fetch with the token). */
  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const meta = await this.call(`${this.base}/${mediaId}`, { headers: this.auth() });
    const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
    const file = await this.call(url, { headers: this.auth() });
    return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: mime_type.split(";")[0]!.trim() };
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  private async send(to: string, message: Record<string, unknown>): Promise<void> {
    await this.call(`${this.base}/${this.cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...message }),
    });
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, init);
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }
}

/** Extracts messages from a webhook payload; ignores status updates. */
export function parseWebhook(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: { changes?: { value?: { messages?: Record<string, any>[] } }[] }[] }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const base = { id: String(m.id), from: String(m.from) };
        if (m.type === "text") out.push({ ...base, type: "text", text: String(m.text?.body ?? "") });
        else if (m.type === "image" || m.type === "video") {
          const media = m[m.type] ?? {};
          out.push({ ...base, type: "media", kind: m.type, mediaId: String(media.id), mimeType: String(media.mime_type ?? ""), caption: media.caption ?? null });
        } else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
          out.push({ ...base, type: "button", buttonId: String(m.interactive.button_reply.id) });
        } else if (m.type === "button") {
          out.push({ ...base, type: "button", buttonId: String(m.button?.payload ?? "") });
        } else out.push({ ...base, type: "unsupported", original: String(m.type) });
      }
    }
  }
  return out;
}

export function approveButtonId(draft: Draft): string {
  return `approve:${draft.id}:${draft.revisionHash}`;
}

/** Sends previews and reports to the owner's WhatsApp. */
export class WhatsAppNotifier implements Notifier {
  private readonly wa: WhatsAppClient;
  private readonly owner: string;

  constructor(wa: WhatsAppClient, ownerNumber: string) {
    this.wa = wa;
    this.owner = ownerNumber;
  }

  async assetsNeeded(draft: Draft): Promise<void> {
    const answered = new Set(draft.assets.map((a) => a.requestId));
    const items = (draft.plan?.assetRequests ?? []).filter((r) => r.required && !answered.has(r.id)).map((r) => r.description);
    await this.wa.sendText(this.owner, t.needAssets(items));
  }

  async preview(draft: Draft, report: PreviewReport): Promise<void> {
    const video = report.mediaUrls.find((m) => m.kind === "video");
    const image = report.mediaUrls.find((m) => m.kind === "image");
    if (video) await this.wa.sendMedia(this.owner, "video", video.url, t.previewCaption(draft));
    else if (image) await this.wa.sendMedia(this.owner, "image", image.url, t.previewCaption(draft));
    await this.wa.sendText(this.owner, previewText(draft, report.issues, report.unlinked));
    await this.wa.sendButtons(this.owner, t.approvePrompt, [
      { id: approveButtonId(draft), title: t.approveButton },
      { id: `edit:${draft.id}`, title: t.editButton },
      { id: `cancel:${draft.id}`, title: t.cancelButton },
    ]);
  }

  async published(draft: Draft): Promise<void> {
    await this.wa.sendText(this.owner, publishReport(draft));
  }

  async failed(draft: Draft): Promise<void> {
    await this.wa.sendText(this.owner, t.failed(draft));
  }
}
