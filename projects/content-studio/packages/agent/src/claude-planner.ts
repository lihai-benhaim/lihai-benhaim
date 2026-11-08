import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ContentPlanSchema, validateRenditionText, type Brief, type ContentPlan } from "@studio/core";
import { PLANNER_SYSTEM, RESEARCH_SYSTEM, planUserPrompt, repairPrompt } from "./prompts.ts";
import { PlannerError, type ContentPlanner, type PlanInput } from "./types.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type BetaMessages = Pick<Anthropic["beta"]["messages"], "parse" | "stream">;

export interface ClaudePlannerOptions {
  /** Defaults to a client that reads ANTHROPIC_API_KEY from the environment. */
  client?: { beta: { messages: BetaMessages } };
  model?: string;
  effort?: Effort;
  /** Run a web-research pass before planning. */
  research?: boolean;
  maxResearchSearches?: number;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Server-side fallback: if the model declines for policy reasons, the API
// retries on Anthropic's recommended fallback model inside the same call.
const FALLBACK: { betas: Anthropic.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

/**
 * Plans content with Claude: an optional research pass with web search, then
 * a structured-output call that returns a ContentPlan, then one repair round if
 * the plan misses a target or breaks a platform limit.
 */
export class ClaudeContentPlanner implements ContentPlanner {
  private readonly messages: BetaMessages;
  private readonly model: string;
  private readonly effort: Effort;
  private readonly research: boolean;
  private readonly maxSearches: number;

  constructor(opts: ClaudePlannerOptions = {}) {
    this.messages = (opts.client ?? new Anthropic()).beta.messages;
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "high";
    this.research = opts.research ?? true;
    this.maxSearches = opts.maxResearchSearches ?? 5;
  }

  async plan(input: PlanInput): Promise<ContentPlan> {
    const notes = this.research && !input.previousPlan ? await this.researchBrief(input.brief) : null;

    const media: Anthropic.Beta.BetaContentBlockParam[] = input.assets
      .filter((a) => a.kind === "image" && IMAGE_TYPES.has(a.mimeType))
      .map((a) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: a.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: Buffer.from(a.data).toString("base64"),
        },
      }));

    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: [...media, { type: "text", text: planUserPrompt(input, notes) }] },
    ];

    const supplied = input.assets.map((a) => a.requestId).filter((id): id is string => Boolean(id));
    let plan = await this.structuredPlan(messages);
    const problems = this.problems(plan, input.brief, supplied);
    if (problems.length) {
      messages.push({ role: "assistant", content: JSON.stringify(plan) });
      messages.push({ role: "user", content: repairPrompt(problems, plan) });
      plan = await this.structuredPlan(messages);
      const remaining = this.problems(plan, input.brief, supplied);
      if (remaining.length) throw new PlannerError("invalid", `Plan still invalid after repair: ${remaining.join("; ")}`);
    }
    return plan;
  }

  private async structuredPlan(messages: Anthropic.Beta.BetaMessageParam[]): Promise<ContentPlan> {
    const res = await this.messages.parse({
      ...FALLBACK,
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: PLANNER_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: this.effort, format: betaZodOutputFormat(ContentPlanSchema) },
      messages,
    });
    if (res.stop_reason === "refusal") {
      throw new PlannerError("refusal", `The model declined this brief${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`);
    }
    if (res.stop_reason === "max_tokens") throw new PlannerError("truncated", "The plan was cut off; the brief may be too large");
    if (!res.parsed_output) throw new PlannerError("invalid", "The model returned no parseable plan");
    return res.parsed_output;
  }

  /** Targets the plan missed or added, and text that breaks platform limits. */
  private problems(plan: ContentPlan, brief: Brief, suppliedAssetIds: string[]): string[] {
    const want = new Set(brief.targets.map((t) => `${t.platform}:${t.format}`));
    const got = new Set(plan.renditions.map((r) => `${r.platform}:${r.format}`));
    const problems: string[] = [];
    for (const t of want) if (!got.has(t)) problems.push(`Missing rendition for ${t}`);
    for (const t of got) if (!want.has(t)) problems.push(`Rendition for ${t} was not requested; remove it`);
    for (const r of plan.renditions) {
      for (const issue of validateRenditionText(r)) if (issue.severity === "error") problems.push(`${r.platform}:${r.format}: ${issue.message}`);
    }
    const usable = new Set([...plan.assetRequests.map((a) => a.id), ...suppliedAssetIds]);
    for (const s of plan.storyboard.scenes) {
      if (s.assetRequestId && !usable.has(s.assetRequestId)) problems.push(`Scene ${s.id} uses unknown asset ${s.assetRequestId}`);
    }
    if (plan.storyboard.scenes.length === 0) problems.push("The storyboard has no scenes");
    return problems;
  }

  /** Web research pass. Returns verified facts with sources, or null if none were needed. */
  private async researchBrief(brief: Brief): Promise<string | null> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `<brief>\n${brief.text}\n</brief>` }];
    let msg: Anthropic.Beta.BetaMessage | undefined;
    // pause_turn: the server-side search loop hit its iteration limit; resend to resume.
    for (let round = 0; round < 4; round++) {
      msg = await this.messages
        .stream({
          ...FALLBACK,
          model: this.model,
          max_tokens: 64000,
          system: RESEARCH_SYSTEM,
          output_config: { effort: "medium" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: this.maxSearches }],
          messages,
        })
        .finalMessage();
      if (msg.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: msg.content });
    }
    if (!msg || msg.stop_reason === "refusal") return null; // Research is optional; plan without it.
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return !text || text.includes("NO_RESEARCH_NEEDED") ? null : text;
  }
}
