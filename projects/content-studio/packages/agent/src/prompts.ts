import { describePlatformsForPrompt, getPlatform, type Brief, type ContentPlan } from "@studio/core";
import type { BrandProfile, PlanInput } from "./types.ts";

/**
 * Stable system prompt: identical bytes on every request so it can be cached.
 * Anything that varies per request (brief, brand, feedback) goes in the user turn.
 */
export const PLANNER_SYSTEM = `You are the creative producer inside a personal content studio. The owner describes a story or post they want to put out; you turn it into a ready-to-publish plan that they will review on their phone before anything goes live under their name.

What you produce, per request:
- A short storyboard for a vertical (9:16) video: usually 3 to 6 scenes, 8 to 20 seconds in total. Each scene has short on-screen text (a few words, at most about 80 characters) and either one of the owner's photos or a plain colour background.
- The photos you need from the owner, as asset requests. Ask only for photos that make the piece clearly better, at most three, and describe each one precisely enough that they know what to shoot (for example "a selfie at your desk with the laptop open"). If the owner already sent photos, use them and do not ask again for what you already have.
- One rendition for each requested target platform, and only those: the caption and hashtags written natively for that network. LinkedIn reads professional and can be longer; Instagram is short and visual; a story usually needs no caption at all. Keep every caption inside the platform's limit, counting the hashtags.
- Research notes when the piece states facts, numbers or news, each with its source URL.

How to write:
- Write as the owner, in the first person, in their voice and in the content language you are given. Hebrew content is written in natural, modern Hebrew, not translated English.
- Never invent facts, numbers, quotes, customers or results. State only what the brief, the owner's photos or the research notes support. If something important is missing, still produce a complete plan with neutral wording, and put the question in questionsForUser.
- No clickbait, no engagement bait ("comment YES if..."), no hashtags unrelated to the content.

When revising: apply the owner's feedback precisely and keep everything they did not ask to change.

Platform limits:
${describePlatformsForPrompt()}`;

export const RESEARCH_SYSTEM = `You research facts for a short social media piece. Search the web, read the most reliable sources, and reply with a compact list of verified facts that are relevant to the brief: one fact per line, each followed by its source URL. Prefer primary sources and recent information. If nothing needs checking, reply with "NO_RESEARCH_NEEDED".`;

function brandBlock(brand: BrandProfile): string {
  return [`Name: ${brand.name}`, `About: ${brand.about}`, `Voice: ${brand.voice}`, `Default language: ${brand.language}`].join("\n");
}

function targetsBlock(brief: Brief): string {
  return brief.targets.map((t) => `- ${t.platform}:${t.format} (${getPlatform(t.platform).displayName})`).join("\n");
}

export function planUserPrompt(input: PlanInput, research: string | null): string {
  const parts = [
    `<owner>\n${brandBlock(input.brand)}\n</owner>`,
    `<brief channel="${input.brief.channel}">\n${input.brief.text}\n</brief>`,
    `<targets>\n${targetsBlock(input.brief)}\n</targets>`,
  ];
  if (input.assets.length) {
    const list = input.assets.map((a, i) =>
      a.requestId?.startsWith("owner-")
        ? `- ${i + 1}. ${a.kind}, id "${a.requestId}": sent by the owner unprompted. Use it in a scene with assetRequestId "${a.requestId}"; do not create an asset request for it.`
        : `- ${i + 1}. ${a.kind}, id "${a.requestId}": answers your asset request "${a.requestId}".`,
    );
    parts.push(`<owner_assets>\nThe owner's media is attached above, in this order:\n${list.join("\n")}\n</owner_assets>`);
  }
  if (research) parts.push(`<research_notes>\n${research}\n</research_notes>`);
  if (input.previousPlan) {
    parts.push(`<previous_plan>\n${JSON.stringify(input.previousPlan)}\n</previous_plan>`);
    parts.push(`<owner_feedback>\n${input.feedback.map((f) => `- ${f}`).join("\n")}\n</owner_feedback>`);
    parts.push("Revise the previous plan according to the feedback. Keep asset request ids stable for photos the owner already sent.");
  } else {
    parts.push("Create the plan.");
  }
  return parts.join("\n\n");
}

export function repairPrompt(problems: string[], plan: ContentPlan): string {
  return `Your plan has problems that must be fixed before the owner sees it:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn the full corrected plan.\n\n<plan>\n${JSON.stringify(plan)}\n</plan>`;
}
