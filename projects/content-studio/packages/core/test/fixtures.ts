import type { ContentPlan, MediaArtifact } from "../src/index.ts";

export function samplePlan(overrides: Partial<ContentPlan> = {}): ContentPlan {
  return {
    language: "he",
    title: "השקת הפרויקט",
    summary: "סטורי קצר על השקת הפרויקט החדש.",
    researchNotes: [],
    assetRequests: [{ id: "photo-1", description: "תמונה שלך מול המחשב", kind: "image", required: true }],
    storyboard: {
      scenes: [
        { id: "s1", durationSec: 3, assetRequestId: "photo-1", overlayText: "יש לי משהו חדש", background: null },
        { id: "s2", durationSec: 3, assetRequestId: null, overlayText: "בקרוב", background: "#101828" },
      ],
      musicMood: null,
    },
    renditions: [
      { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
      { platform: "linkedin", format: "feed_video", caption: "משיק היום משהו חדש", hashtags: ["AI", "build"], title: null, linkUrl: null },
    ],
    questionsForUser: [],
    ...overrides,
  };
}

export function sampleVideo(overrides: Partial<MediaArtifact> = {}): MediaArtifact {
  return {
    id: "m1",
    kind: "video",
    mimeType: "video/mp4",
    key: "drafts/d1/story.mp4",
    sha256: "abc",
    width: 1080,
    height: 1920,
    durationSec: 6,
    aspect: "9:16",
    ...overrides,
  };
}
