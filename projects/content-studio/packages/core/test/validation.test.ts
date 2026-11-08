import { describe, expect, it } from "vitest";
import { composeCaption, mediaForTarget, parseTarget, validateRendition } from "../src/index.ts";
import { sampleVideo } from "./fixtures.ts";

describe("validation", () => {
  it("accepts a story video within limits", () => {
    const issues = validateRendition(
      { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
      [sampleVideo()],
    );
    expect(issues).toEqual([]);
  });

  it("flags captions over the limit, counting hashtags", () => {
    const issues = validateRendition(
      { platform: "x", format: "text", caption: "א".repeat(275), hashtags: ["AI", "ML"], title: null, linkUrl: null },
      [],
    );
    expect(issues.map((i) => i.severity)).toEqual(["error"]);
  });

  it("flags wrong aspect and video length", () => {
    const issues = validateRendition(
      { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
      [sampleVideo({ aspect: "16:9", durationSec: 75 })],
    );
    expect(issues).toHaveLength(2);
  });

  it("requires at least two items for a carousel", () => {
    const issues = validateRendition(
      { platform: "instagram", format: "carousel", caption: "x", hashtags: [], title: null, linkUrl: null },
      [sampleVideo({ kind: "image", aspect: "4:5", durationSec: null })],
    );
    expect(issues.map((i) => i.message)).toEqual(["1 item(s); needs at least 2"]);
  });

  it("composes caption with hashtags", () => {
    expect(composeCaption({ caption: "שלום", hashtags: ["AI", "#build tools"] })).toBe("שלום\n\n#AI #buildtools");
  });

  it("picks matching media for a target", () => {
    const vertical = sampleVideo();
    const square = sampleVideo({ id: "m2", aspect: "1:1" });
    expect(mediaForTarget({ platform: "instagram", format: "story" }, [square, vertical])).toEqual([vertical]);
    expect(mediaForTarget({ platform: "linkedin", format: "text" }, [vertical])).toEqual([]);
  });

  it("parses targets", () => {
    expect(parseTarget("instagram:story")).toEqual({ platform: "instagram", format: "story" });
    expect(() => parseTarget("linkedin:story")).toThrow();
    expect(() => parseTarget("myspace:post")).toThrow();
  });
});
