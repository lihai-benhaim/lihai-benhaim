import { describe, expect, it } from "vitest";
import type { ContentPlan } from "@studio/core";
import { ClaudeContentPlanner, PlannerError, type PlanInput } from "../src/index.ts";

const brand = { name: "Lihai", about: "Engineer", voice: "Direct, warm", language: "he" };

const input: PlanInput = {
  brief: {
    text: "סטורי על הפרויקט החדש",
    channel: "whatsapp",
    targets: [
      { platform: "instagram", format: "story" },
      { platform: "linkedin", format: "feed_video" },
    ],
  },
  brand,
  assets: [{ requestId: null, kind: "image", mimeType: "image/jpeg", data: new Uint8Array([1, 2, 3]) }],
  previousPlan: null,
  feedback: [],
};

function plan(renditions: ContentPlan["renditions"]): ContentPlan {
  return {
    language: "he",
    title: "t",
    summary: "s",
    researchNotes: [],
    assetRequests: [],
    storyboard: { scenes: [{ id: "s1", durationSec: 3, assetRequestId: null, overlayText: "היי", background: "#000000" }], musicMood: null },
    renditions,
    questionsForUser: [],
  };
}

const story = { platform: "instagram" as const, format: "story" as const, caption: "", hashtags: [], title: null, linkUrl: null };
const li = { platform: "linkedin" as const, format: "feed_video" as const, caption: "פוסט", hashtags: ["AI"], title: null, linkUrl: null };

function fakeClient(responses: Partial<{ stop_reason: string; parsed_output: ContentPlan | null; stop_details: unknown }>[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: any) => {
          requests.push(params);
          return { stop_reason: "end_turn", stop_details: null, ...responses[requests.length - 1] };
        },
        stream: () => {
          throw new Error("research disabled in this test");
        },
      },
    },
  };
  return { client: client as any, requests };
}

describe("ClaudeContentPlanner", () => {
  it("asks for a structured plan with the owner's photos attached", async () => {
    const { client, requests } = fakeClient([{ parsed_output: plan([story, li]) }]);
    const planner = new ClaudeContentPlanner({ client, research: false });
    const out = await planner.plan(input);

    expect(out.renditions).toHaveLength(2);
    const req = requests[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toContain("server-side-fallback-2026-07-01");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.messages[0].content[0].type).toBe("image");
    expect(req.messages[0].content[1].text).toContain("instagram:story");
  });

  it("repairs a plan that misses a target", async () => {
    const { client, requests } = fakeClient([{ parsed_output: plan([story]) }, { parsed_output: plan([story, li]) }]);
    const out = await new ClaudeContentPlanner({ client, research: false }).plan(input);
    expect(out.renditions).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1).content).toContain("Missing rendition for linkedin:feed_video");
  });

  it("surfaces refusals as PlannerError", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", parsed_output: null, stop_details: { category: null } }]);
    await expect(new ClaudeContentPlanner({ client, research: false }).plan(input)).rejects.toBeInstanceOf(PlannerError);
  });
});
