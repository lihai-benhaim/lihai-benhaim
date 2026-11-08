import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplatePlanner } from "@studio/agent";
import type { Draft } from "@studio/core";
import type { MediaRenderer, RenderInput, RenderedFile } from "@studio/media";
import { DryRunPublisher, PublisherRegistry, type FetchLike } from "@studio/publishers";
import { buildApp } from "../src/app.ts";
import { WhatsAppClient, WhatsAppNotifier } from "../src/channels/whatsapp.ts";
import { MediaStore } from "../src/media-store.ts";
import { Secrets } from "../src/secrets.ts";
import { StateStore } from "../src/store.ts";
import { Studio, type Notifier, type PreviewReport } from "../src/studio.ts";

/** Writes placeholder files instead of running ffmpeg (the renderer has its own tests). */
export class FakeRenderer implements MediaRenderer {
  calls = 0;
  async render(input: RenderInput): Promise<RenderedFile[]> {
    this.calls++;
    await mkdir(input.outDir, { recursive: true });
    const video = join(input.outDir, "story-9x16.mp4");
    const cover = join(input.outDir, "cover-4x5.jpg");
    await writeFile(video, Buffer.from(`video ${input.plan.title} ${input.assets.length}`));
    await writeFile(cover, Buffer.from("jpeg"));
    return [
      { kind: "video", mimeType: "video/mp4", path: video, width: 1080, height: 1920, durationSec: 6, aspect: "9:16", sha256: `v${this.calls}`, sizeBytes: 10 },
      { kind: "image", mimeType: "image/jpeg", path: cover, width: 1080, height: 1350, durationSec: null, aspect: "4:5", sha256: `i${this.calls}`, sizeBytes: 4 },
    ];
  }
}

export class RecordingNotifier implements Notifier {
  events: { type: string; draft: Draft; report?: PreviewReport }[] = [];
  async assetsNeeded(draft: Draft) {
    this.events.push({ type: "assetsNeeded", draft });
  }
  async preview(draft: Draft, report: PreviewReport) {
    this.events.push({ type: "preview", draft, report });
  }
  async published(draft: Draft) {
    this.events.push({ type: "published", draft });
  }
  async failed(draft: Draft) {
    this.events.push({ type: "failed", draft });
  }
}

export const ADMIN = "test-admin-token-0123456789";
export const OWNER = "972500000000";
export const WA_SECRET = "wa-app-secret";

export async function setup(opts: { whatsapp?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "studio-server-"));
  const secrets = new Secrets(randomBytes(32).toString("base64"));
  const store = StateStore.memory(secrets);
  const media = new MediaStore(join(dir, "media"), "https://studio.test", secrets);
  const instagram = new DryRunPublisher("instagram");
  const linkedin = new DryRunPublisher("linkedin");
  const publishers = new PublisherRegistry([instagram, linkedin]);

  const waSent: { to: string; body: any }[] = [];
  const waFetch: FetchLike = async (url, init) => {
    if (url.endsWith("/messages")) {
      waSent.push({ to: JSON.parse(init!.body as string).to, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }));
    }
    if (url.includes("/media-123")) return new Response(JSON.stringify({ url: "https://lookaside.test/file", mime_type: "image/jpeg" }));
    if (url === "https://lookaside.test/file") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
    return new Response("not found", { status: 404 });
  };
  const whatsapp = opts.whatsapp
    ? new WhatsAppClient({ token: "wa-token", phoneNumberId: "pn-1", appSecret: WA_SECRET, graphVersion: "v23.0", fetch: waFetch })
    : null;

  const recorder = new RecordingNotifier();
  const renderer = new FakeRenderer();
  const studio = new Studio({
    ownerId: "owner",
    brand: { name: "Lihai", about: "Engineer", voice: "Direct", language: "he" },
    store,
    media,
    planner: new TemplatePlanner(),
    renderer,
    publishers,
    notifier: whatsapp ? new WhatsAppNotifier(whatsapp, OWNER) : recorder,
  });

  const app = await buildApp({
    config: {
      PUBLIC_BASE_URL: "https://studio.test",
      STUDIO_ADMIN_TOKEN: ADMIN,
      WHATSAPP_VERIFY_TOKEN: "verify-me",
      OWNER_WHATSAPP: OWNER,
      defaultTargets: [{ platform: "instagram", format: "story" }],
      PUBLISH_MODE: "dry-run",
    },
    studio,
    store,
    media,
    publishers,
    secrets,
    whatsapp,
  });

  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await app.webhooksIdle();
      await studio.idle();
    }
  };

  const webhook = (messages: Record<string, unknown>[], sign = true) => {
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messages } }] }] });
    const sig = `sha256=${createHmac("sha256", WA_SECRET).update(payload).digest("hex")}`;
    return app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload,
      headers: { "content-type": "application/json", ...(sign ? { "x-hub-signature-256": sig } : {}) },
    });
  };

  return {
    app,
    studio,
    store,
    media,
    secrets,
    instagram,
    linkedin,
    recorder,
    renderer,
    waSent,
    settle,
    webhook,
    auth: { authorization: `Bearer ${ADMIN}` },
    cleanup: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function multipart(bytes: Uint8Array, mimeType: string, filename = "photo.jpg") {
  const boundary = "----studio-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
