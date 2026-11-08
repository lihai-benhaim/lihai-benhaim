import type { ContentPlan, Rendition } from "@studio/core";
import type { ContentPlanner, PlanInput } from "./types.ts";

/**
 * Offline planner with no AI: turns the brief into a fixed two-scene story.
 * Only for tests and for trying the publish flow end to end without an API
 * key. Enabled explicitly with PLANNER=template; never a silent fallback.
 */
export class TemplatePlanner implements ContentPlanner {
  async plan(input: PlanInput): Promise<ContentPlan> {
    const text = input.brief.text.trim();
    const headline = text.split(/[.!?\n]/)[0]!.slice(0, 70);
    const caption = input.feedback.length ? `${text}\n\n(${input.feedback.at(-1)})` : text;
    const renditions: Rendition[] = input.brief.targets.map((t) => ({
      platform: t.platform,
      format: t.format,
      caption: t.format === "story" ? "" : caption.slice(0, 250),
      hashtags: [],
      title: null,
      linkUrl: null,
    }));
    // Use a photo the owner already sent; otherwise ask for one.
    const supplied = input.assets.find((a) => a.kind === "image" && a.requestId)?.requestId ?? null;
    const photoId = supplied ?? "photo-1";
    return {
      language: input.brand.language,
      title: headline,
      summary: text.slice(0, 200),
      researchNotes: [],
      assetRequests: supplied ? [] : [{ id: "photo-1", description: "A photo for the opening scene", kind: "image", required: true }],
      storyboard: {
        scenes: [
          { id: "s1", durationSec: 3, assetRequestId: photoId, overlayText: headline, background: null },
          { id: "s2", durationSec: 3, assetRequestId: null, overlayText: input.brand.name, background: "#101828" },
        ],
        musicMood: null,
      },
      renditions,
      questionsForUser: [],
    };
  }
}
