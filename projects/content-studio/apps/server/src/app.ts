import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  InvalidTransitionError,
  StaleApprovalError,
  isPlatformId,
  listPlatforms,
  parseTarget,
  type Draft,
  type PlatformId,
} from "@studio/core";
import type { PublisherRegistry } from "@studio/publishers";
import type { Config } from "./config.ts";
import { Conversation } from "./channels/conversation.ts";
import { parseWebhook, type WhatsAppClient } from "./channels/whatsapp.ts";
import { mimeFromKey, type MediaStore } from "./media-store.ts";
import type { Secrets } from "./secrets.ts";
import type { StateStore } from "./store.ts";
import { NotFoundError, type Studio } from "./studio.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
  interface FastifyInstance {
    /** Resolves when queued WhatsApp messages have been handled (tests, shutdown). */
    webhooksIdle(): Promise<void>;
  }
}

export interface AppDeps {
  config: Pick<Config, "PUBLIC_BASE_URL" | "STUDIO_ADMIN_TOKEN" | "WHATSAPP_VERIFY_TOKEN" | "OWNER_WHATSAPP" | "defaultTargets" | "PUBLISH_MODE">;
  studio: Studio;
  store: StateStore;
  media: MediaStore;
  publishers: PublisherRegistry;
  secrets: Secrets;
  whatsapp: WhatsAppClient | null;
  logger?: boolean;
}

const UI_FILE = fileURLToPath(new URL("../public/index.html", import.meta.url));

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, studio, store, media, publishers, secrets } = deps;
  const ownerId = studio.ownerId;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 10 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found", message: err.message });
    if (err instanceof StaleApprovalError) return reply.code(409).send({ error: "stale_approval", message: err.message });
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ error: "invalid_state", message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "bad_request", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: "error", message: status >= 500 ? "Internal error" : (err as Error).message });
  });

  const connectUrl = (platform: PlatformId): string | null => {
    const publisher = publishers.get(platform);
    if (!publisher) return null;
    const state = secrets.seal({ p: platform, o: ownerId }, 15 * 60);
    return publisher.authorizationUrl({ state, redirectUri: `${config.PUBLIC_BASE_URL}/connect/${platform}/callback` });
  };

  const draftView = (d: Draft) => ({
    ...d,
    report: studio.report(d),
    assets: d.assets.map((a) => ({ ...a, url: media.publicUrl(a.key, 3600) })),
  });

  // ---- public routes ----------------------------------------------------------

  app.get("/health", async () => ({ ok: true, publishMode: config.PUBLISH_MODE }));

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(await readFile(UI_FILE, "utf8")));

  /** Signed media URLs: previews in the UI and in WhatsApp, and media Instagram downloads. */
  app.get("/media/*", async (req: FastifyRequest<{ Params: { "*": string }; Querystring: { exp?: string; sig?: string } }>, reply) => {
    const key = req.params["*"].split("/").map(decodeURIComponent).join("/");
    if (!media.verifyUrl(key, req.query.exp, req.query.sig)) return reply.code(403).send({ error: "forbidden" });
    const path = media.path(key);
    const size = (await stat(path).catch(() => null))?.size;
    if (size === undefined) return reply.code(404).send({ error: "not_found" });
    reply.header("Accept-Ranges", "bytes").header("Cache-Control", "private, max-age=3600").type(mimeFromKey(key));
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
      return reply.send(createReadStream(path, { start, end }));
    }
    reply.header("Content-Length", size);
    return reply.send(createReadStream(path));
  });

  /** OAuth callback: the owner comes back here after granting access on the network's site. */
  app.get(
    "/connect/:platform/callback",
    async (req: FastifyRequest<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>, reply) => {
      const { platform } = req.params;
      const state = req.query.state ? secrets.unseal<{ p: string; o: string }>(req.query.state) : null;
      if (!isPlatformId(platform) || !state || state.p !== platform || state.o !== ownerId) {
        return reply.code(400).type("text/plain").send("Invalid or expired link. Start linking again from the studio.");
      }
      if (req.query.error || !req.query.code) return reply.redirect(`/?link_error=${encodeURIComponent(platform)}`);
      const publisher = publishers.get(platform);
      if (!publisher) return reply.code(404).send();
      const account = await publisher.completeAuthorization({
        code: req.query.code,
        redirectUri: `${config.PUBLIC_BASE_URL}/connect/${platform}/callback`,
      });
      await store.saveAccount(ownerId, account);
      return reply.redirect(`/?linked=${encodeURIComponent(platform)}`);
    },
  );

  // ---- WhatsApp webhook (own content-type parser so the raw body can be verified) ----

  const pending = new Set<Promise<void>>();
  const seen: string[] = [];
  app.decorate("webhooksIdle", async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  });

  if (deps.whatsapp && config.OWNER_WHATSAPP && config.WHATSAPP_VERIFY_TOKEN) {
    const wa = deps.whatsapp;
    const owner = config.OWNER_WHATSAPP;
    const verifyToken = config.WHATSAPP_VERIFY_TOKEN;
    const conversation = new Conversation(studio, config.defaultTargets);

    await app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
        req.rawBody = body as string;
        try {
          done(null, JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      });

      scope.get("/webhooks/whatsapp", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
        const q = req.query;
        if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === verifyToken) return reply.type("text/plain").send(q["hub.challenge"]);
        return reply.code(403).send();
      });

      scope.post("/webhooks/whatsapp", async (req, reply) => {
        if (!wa.verifySignature(req.rawBody ?? "", req.headers["x-hub-signature-256"] as string | undefined)) {
          return reply.code(401).send();
        }
        for (const msg of parseWebhook(req.body)) {
          if (seen.includes(msg.id)) continue; // WhatsApp redelivers until it gets a 200.
          seen.push(msg.id);
          if (seen.length > 1000) seen.shift();
          if (msg.from !== owner) {
            app.log.warn({ from: msg.from }, "ignoring WhatsApp message from a number that is not the owner");
            continue;
          }
          const io = {
            reply: (text: string) => wa.sendText(owner, text),
            download: (id: string) => wa.downloadMedia(id),
            accountsSummary: () => accountLines(),
          };
          const ctx = { activeDraft: () => store.activeDraft(ownerId), linkedPlatforms: () => store.listAccounts(ownerId).map((a) => a.platform) };
          const task = conversation.handle(msg, io, ctx).catch(async (err: unknown) => {
            app.log.error(err);
            await wa.sendText(owner, `שגיאה: ${(err as Error).message}`).catch(() => {});
          });
          pending.add(task);
          void task.finally(() => pending.delete(task));
        }
        return reply.send({ ok: true });
      });
    });
  }

  const accountLines = (): string[] =>
    listPlatforms()
      .filter((p) => publishers.get(p.id))
      .map((p) => {
        const acc = store.getAccount(ownerId, p.id);
        return acc ? `✅ ${p.displayName}: ${acc.displayName}` : `🔗 ${p.displayName}: ${connectUrl(p.id)}`;
      });

  // ---- authenticated API --------------------------------------------------------

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (req, reply) => {
        const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
        const expected = Buffer.from(config.STUDIO_ADMIN_TOKEN);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.code(401).send({ error: "unauthorized" });
      });

      api.get("/platforms", async () =>
        listPlatforms().map((p) => {
          const acc = store.getAccount(ownerId, p.id);
          return {
            ...p,
            available: Boolean(publishers.get(p.id)),
            linked: acc ? { displayName: acc.displayName, expiresAt: acc.credentials.expiresAt } : null,
          };
        }),
      );

      api.post("/connect/:platform", async (req: FastifyRequest<{ Params: { platform: string } }>, reply) => {
        const { platform } = req.params;
        const url = isPlatformId(platform) ? connectUrl(platform) : null;
        if (!url) return reply.code(404).send({ error: "not_available", message: `${platform} is not configured on this server` });
        return { url };
      });

      api.delete("/accounts/:platform", async (req: FastifyRequest<{ Params: { platform: string } }>, reply) => {
        const { platform } = req.params;
        if (!isPlatformId(platform)) return reply.code(404).send();
        return { removed: await store.removeAccount(ownerId, platform) };
      });

      api.get("/drafts", async () => store.listDrafts(ownerId).map(draftView));

      api.get("/drafts/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
        const d = store.getDraft(req.params.id);
        if (!d || d.ownerId !== ownerId) throw new NotFoundError(req.params.id);
        return draftView(d);
      });

      api.post("/drafts", async (req, reply) => {
        const body = z.object({ text: z.string().min(1), targets: z.array(z.string()).optional() }).parse(req.body);
        const targets = body.targets?.length ? body.targets.map(parseTarget) : config.defaultTargets;
        const draft = await studio.createDraft({ text: body.text, targets, channel: "web" });
        return reply.code(201).send(draftView(draft));
      });

      api.post("/drafts/:id/assets", async (req: FastifyRequest<{ Params: { id: string }; Querystring: { requestId?: string } }>) => {
        const file = await req.file();
        if (!file) throw Object.assign(new Error("no file uploaded"), { statusCode: 400 });
        const draft = await studio.addAsset(req.params.id, {
          bytes: await file.toBuffer(),
          mimeType: file.mimetype,
          requestId: req.query.requestId ?? null,
        });
        return draftView(draft);
      });

      api.post("/drafts/:id/feedback", async (req: FastifyRequest<{ Params: { id: string } }>) => {
        const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
        return draftView(await studio.feedback(req.params.id, text));
      });

      api.post("/drafts/:id/approve", async (req: FastifyRequest<{ Params: { id: string } }>) => {
        const { revisionHash } = z.object({ revisionHash: z.string().min(1) }).parse(req.body);
        return draftView(await studio.approve(req.params.id, revisionHash, "web"));
      });

      api.post("/drafts/:id/cancel", async (req: FastifyRequest<{ Params: { id: string } }>) => draftView(await studio.cancel(req.params.id)));
    },
    { prefix: "/api" },
  );

  return app;
}

