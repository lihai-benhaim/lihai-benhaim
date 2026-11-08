import { z } from "zod";
import { parseTarget, type Target } from "@studio/core";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** Public HTTPS address of this server (Cloudflare Tunnel / reverse proxy on the NAS). */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  DATA_DIR: z.string().default("./data"),
  /** 32 random bytes, base64. Encrypts OAuth tokens at rest and signs links. `openssl rand -base64 32` */
  APP_SECRET_KEY: z.string().min(1),
  /** Bearer token for the web studio and the REST API. */
  STUDIO_ADMIN_TOKEN: z.string().min(16),

  OWNER_NAME: z.string().default("Owner"),
  BRAND_ABOUT: z.string().default(""),
  BRAND_VOICE: z.string().default("Direct, warm, no buzzwords."),
  CONTENT_LANGUAGE: z.string().default("he"),
  DEFAULT_TARGETS: z.string().default("instagram:story,linkedin:feed_video"),

  /** "claude" (default) or "template" (offline, no AI; for trying the flow). */
  PLANNER: z.enum(["claude", "template"]).default("claude"),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  RESEARCH: z
    .enum(["on", "off"])
    .default("on")
    .transform((v) => v === "on"),

  FONT_FILE: z.string().default("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
  MUSIC_FILE: optional,

  /** "live" publishes for real; "dry-run" records posts without sending them. */
  PUBLISH_MODE: z.enum(["live", "dry-run"]).default("dry-run"),

  INSTAGRAM_APP_ID: optional,
  INSTAGRAM_APP_SECRET: optional,
  INSTAGRAM_GRAPH_VERSION: z.string().default("v23.0"),
  LINKEDIN_CLIENT_ID: optional,
  LINKEDIN_CLIENT_SECRET: optional,
  LINKEDIN_API_VERSION: z.string().default("202510"),

  WHATSAPP_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
  /** The owner's number in international format, digits only (e.g. 972501234567). Only this number can use the bot. */
  OWNER_WHATSAPP: optional,
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  defaultTargets: Target[];
  whatsappEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration (see .env.example):\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const wa = [e.WHATSAPP_TOKEN, e.WHATSAPP_PHONE_NUMBER_ID, e.WHATSAPP_APP_SECRET, e.WHATSAPP_VERIFY_TOKEN, e.OWNER_WHATSAPP];
  if (wa.some(Boolean) && !wa.every(Boolean)) {
    throw new Error("WhatsApp needs all of WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, OWNER_WHATSAPP");
  }
  return {
    ...e,
    PUBLIC_BASE_URL: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    defaultTargets: e.DEFAULT_TARGETS.split(",").filter(Boolean).map(parseTarget),
    whatsappEnabled: wa.every(Boolean),
  };
}
