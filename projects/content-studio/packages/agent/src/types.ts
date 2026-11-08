import type { Brief, ContentPlan } from "@studio/core";

/** Who is speaking. Fed to the agent so the content sounds like the owner. */
export interface BrandProfile {
  name: string;
  /** One paragraph: who they are, what they do. */
  about: string;
  /** How they write: tone, length, emoji use, words to avoid. */
  voice: string;
  /** Default content language, BCP-47 (e.g. "he"). */
  language: string;
}

export interface PlannerAsset {
  requestId: string | null;
  kind: "image" | "video";
  mimeType: string;
  /** Raw bytes. Images are shown to the model; videos are only described. */
  data: Uint8Array;
}

export interface PlanInput {
  brief: Brief;
  brand: BrandProfile;
  assets: PlannerAsset[];
  /** Set when revising: the plan the owner saw and the feedback they gave. */
  previousPlan: ContentPlan | null;
  feedback: string[];
}

export interface ContentPlanner {
  plan(input: PlanInput): Promise<ContentPlan>;
}

export class PlannerError extends Error {
  readonly kind: "refusal" | "truncated" | "invalid";

  constructor(kind: PlannerError["kind"], message: string) {
    super(message);
    this.name = "PlannerError";
    this.kind = kind;
  }
}
