import { z } from "zod";
import { CONTENT_FORMATS, PLATFORM_IDS } from "./platforms.ts";

/**
 * The content plan is what the agent produces from a brief: research, the
 * photos it needs from the user, a storyboard for the video, and one rendition
 * (caption, hashtags, title) per target platform.
 *
 * The schema is used for Claude structured outputs, so it sticks to features
 * structured outputs support: nullable instead of optional, no numeric bounds.
 */

export const AssetRequestSchema = z.object({
  id: z.string().describe("Short stable id, e.g. 'photo-1'. Scenes reference it."),
  description: z.string().describe("What the user should send, written in the brief's language."),
  kind: z.enum(["image", "video"]),
  required: z.boolean(),
});
export type AssetRequest = z.infer<typeof AssetRequestSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  durationSec: z.number().describe("Seconds on screen, usually 2-6."),
  assetRequestId: z
    .string()
    .nullable()
    .describe("Id of the asset request that fills this scene, or null for a plain colour background."),
  overlayText: z.string().describe("Short on-screen text (at most about 80 characters). Empty string for none."),
  background: z.string().nullable().describe("Hex colour such as #101828, used when there is no asset."),
});
export type Scene = z.infer<typeof SceneSchema>;

export const RenditionSchema = z.object({
  platform: z.enum(PLATFORM_IDS),
  format: z.enum(CONTENT_FORMATS),
  caption: z.string().describe("Post text for this platform, within its limit. Empty for formats with no caption."),
  hashtags: z.array(z.string()).describe("Without the leading #."),
  title: z.string().nullable().describe("Only for platforms with a separate title (YouTube, Pinterest)."),
  linkUrl: z.string().nullable(),
});
export type Rendition = z.infer<typeof RenditionSchema>;

export const ResearchNoteSchema = z.object({
  point: z.string(),
  sourceUrl: z.string().nullable(),
});
export type ResearchNote = z.infer<typeof ResearchNoteSchema>;

export const ContentPlanSchema = z.object({
  language: z.string().describe("Language of the content as a BCP-47 tag, e.g. 'he' or 'en'."),
  title: z.string().describe("Internal working title of the piece."),
  summary: z.string().describe("Two or three sentences: what this piece says and why."),
  researchNotes: z.array(ResearchNoteSchema),
  assetRequests: z.array(AssetRequestSchema),
  storyboard: z.object({
    scenes: z.array(SceneSchema),
    musicMood: z.string().nullable(),
  }),
  renditions: z.array(RenditionSchema),
  questionsForUser: z.array(z.string()).describe("Open questions for the user. Empty when there are none."),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

export function storyboardDurationSec(plan: ContentPlan): number {
  return plan.storyboard.scenes.reduce((sum, s) => sum + s.durationSec, 0);
}
