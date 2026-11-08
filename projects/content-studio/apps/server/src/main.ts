import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeContentPlanner, TemplatePlanner, type ContentPlanner } from "@studio/agent";
import { PLATFORM_IDS, getPlatform } from "@studio/core";
import { FfmpegRenderer } from "@studio/media";
import { DryRunPublisher, InstagramPublisher, LinkedInPublisher, PublisherRegistry } from "@studio/publishers";
import { buildApp } from "./app.ts";
import { WhatsAppClient, WhatsAppNotifier } from "./channels/whatsapp.ts";
import { loadConfig, type Config } from "./config.ts";
import { MediaStore } from "./media-store.ts";
import { publishReport } from "./messages.ts";
import { Secrets } from "./secrets.ts";
import { StateStore } from "./store.ts";
import { Studio, type Notifier } from "./studio.ts";

/** Used when WhatsApp is not configured: progress shows up in the web studio and the log. */
class LogNotifier implements Notifier {
  async assetsNeeded(d: Parameters<Notifier["assetsNeeded"]>[0]) {
    console.log(`[${d.id}] waiting for photos: ${d.plan?.assetRequests.map((r) => r.description).join(" | ")}`);
  }
  async preview(d: Parameters<Notifier["preview"]>[0]) {
    console.log(`[${d.id}] preview ready (revision ${d.revision}) — approve it in the web studio`);
  }
  async published(d: Parameters<Notifier["published"]>[0]) {
    console.log(`[${d.id}] ${publishReport(d)}`);
  }
  async failed(d: Parameters<Notifier["failed"]>[0]) {
    console.log(`[${d.id}] failed: ${d.error}`);
  }
}

function buildPublishers(config: Config): PublisherRegistry {
  const registry = new PublisherRegistry();
  if (config.PUBLISH_MODE === "dry-run") {
    for (const id of PLATFORM_IDS) registry.register(new DryRunPublisher(id));
    return registry;
  }
  if (config.INSTAGRAM_APP_ID && config.INSTAGRAM_APP_SECRET) {
    registry.register(
      new InstagramPublisher({ appId: config.INSTAGRAM_APP_ID, appSecret: config.INSTAGRAM_APP_SECRET, graphVersion: config.INSTAGRAM_GRAPH_VERSION }),
    );
  }
  if (config.LINKEDIN_CLIENT_ID && config.LINKEDIN_CLIENT_SECRET) {
    registry.register(
      new LinkedInPublisher({ clientId: config.LINKEDIN_CLIENT_ID, clientSecret: config.LINKEDIN_CLIENT_SECRET, apiVersion: config.LINKEDIN_API_VERSION }),
    );
  }
  return registry;
}

function buildPlanner(config: Config): ContentPlanner {
  if (config.PLANNER === "template") return new TemplatePlanner();
  return new ClaudeContentPlanner({ model: config.CLAUDE_MODEL, research: config.RESEARCH });
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!existsSync(config.FONT_FILE)) {
    throw new Error(`FONT_FILE not found: ${config.FONT_FILE}. Point it at a .ttf with Hebrew glyphs (e.g. Noto Sans Hebrew or DejaVu Sans).`);
  }
  const dataDir = resolve(config.DATA_DIR);
  const secrets = new Secrets(config.APP_SECRET_KEY);
  const store = await StateStore.open(join(dataDir, "state.json"), secrets);
  const media = new MediaStore(join(dataDir, "media"), config.PUBLIC_BASE_URL, secrets);
  const publishers = buildPublishers(config);

  const whatsapp = config.whatsappEnabled
    ? new WhatsAppClient({
        token: config.WHATSAPP_TOKEN!,
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID!,
        appSecret: config.WHATSAPP_APP_SECRET!,
        graphVersion: config.WHATSAPP_GRAPH_VERSION,
      })
    : null;

  const studio = new Studio({
    ownerId: "owner",
    brand: { name: config.OWNER_NAME, about: config.BRAND_ABOUT, voice: config.BRAND_VOICE, language: config.CONTENT_LANGUAGE },
    store,
    media,
    planner: buildPlanner(config),
    renderer: new FfmpegRenderer({ fontFile: config.FONT_FILE, musicPath: config.MUSIC_FILE ?? null }),
    publishers,
    notifier: whatsapp ? new WhatsAppNotifier(whatsapp, config.OWNER_WHATSAPP!) : new LogNotifier(),
    log: (msg, err) => console.error(msg, err ?? ""),
  });

  const app = await buildApp({ config, studio, store, media, publishers, secrets, whatsapp, logger: true });

  const shutdown = async () => {
    app.log.info("shutting down, finishing in-flight work");
    await app.close();
    await Promise.race([Promise.all([studio.idle(), app.webhooksIdle()]), new Promise((r) => setTimeout(r, 60_000))]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    {
      publishMode: config.PUBLISH_MODE,
      planner: config.PLANNER,
      whatsapp: config.whatsappEnabled,
      networks: publishers.platforms().map((p) => getPlatform(p).displayName),
    },
    "content studio ready",
  );
  if (config.PUBLIC_BASE_URL.startsWith("http://localhost")) {
    app.log.warn("PUBLIC_BASE_URL is localhost: Instagram and WhatsApp cannot fetch media from here. See docs/nas-setup.md (Cloudflare Tunnel).");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
