import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getFormatSpec, validateRendition, type ContentPlan } from "@studio/core";
import { FfmpegRenderer, aspectLabel, wrapText } from "../src/index.ts";

const FONT = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
let hasFfmpeg = false;
try {
  execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
  hasFfmpeg = true;
} catch {}

describe("text helpers", () => {
  it("wraps on word boundaries", () => {
    expect(wrapText("יש לי משהו חדש להראות לכם היום", 12)).toBe("יש לי משהו\nחדש להראות\nלכם היום");
  });
  it("labels aspect ratios", () => {
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1080, 1350)).toBe("4:5");
    expect(aspectLabel(1000, 1000)).toBe("1:1");
  });
});

describe.skipIf(!hasFfmpeg || !FONT)("FfmpegRenderer", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("renders a Hebrew story from a photo and a colour scene", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-test-"));
    dirs.push(dir);
    const photo = join(dir, "photo.jpg");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1200x900", "-frames:v", "1", photo]);

    const plan: ContentPlan = {
      language: "he",
      title: "t",
      summary: "s",
      researchNotes: [],
      assetRequests: [{ id: "photo-1", description: "x", kind: "image", required: true }],
      storyboard: {
        scenes: [
          { id: "s1", durationSec: 2, assetRequestId: "photo-1", overlayText: "יש לי משהו חדש להראות לכם", background: null },
          { id: "s2", durationSec: 2, assetRequestId: null, overlayText: "Coming soon · בקרוב", background: "#1d4ed8" },
        ],
        musicMood: null,
      },
      renditions: [],
      questionsForUser: [],
    };

    const renderer = new FfmpegRenderer({ fontFile: FONT! });
    const files = await renderer.render({ plan, assets: [{ requestId: "photo-1", kind: "image", path: photo }], outDir: join(dir, "out") });

    const video = files.find((f) => f.kind === "video")!;
    expect(video).toMatchObject({ width: 1080, height: 1920, aspect: "9:16" });
    expect(video.durationSec).toBeGreaterThan(3.8);
    expect(video.durationSec).toBeLessThan(4.3);

    const cover = files.find((f) => f.kind === "image")!;
    expect(cover).toMatchObject({ width: 1080, height: 1350, aspect: "4:5" });

    // The rendered story passes Instagram's story checks.
    expect(getFormatSpec("instagram", "story")).toBeDefined();
    const issues = validateRendition(
      { platform: "instagram", format: "story", caption: "", hashtags: [], title: null, linkUrl: null },
      [{ id: "v", key: "k", ...video }],
    );
    expect(issues).toEqual([]);
  });

  it("draws the overlay text on the cover image (no fade-in on stills)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-test-"));
    dirs.push(dir);
    const plan: ContentPlan = {
      language: "he",
      title: "t",
      summary: "s",
      researchNotes: [],
      assetRequests: [],
      storyboard: { scenes: [{ id: "s1", durationSec: 3, assetRequestId: null, overlayText: "שלום", background: "#0000ff" }], musicMood: null },
      renditions: [],
      questionsForUser: [],
    };
    const files = await new FfmpegRenderer({ fontFile: FONT! }).render({ plan, assets: [], outDir: join(dir, "out") });
    const cover = files.find((f) => f.kind === "image")!.path;
    // Sample a pixel inside the text box (centred, 68% down) and one far from it.
    const pixel = (x: number, y: number) =>
      [...execFileSync("ffmpeg", ["-v", "error", "-i", cover, "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])].slice(0, 3);
    const background = pixel(20, 20);
    const insideBox = pixel(540, Math.round(1350 * 0.68) - 40);
    expect(background[2]).toBeGreaterThan(200); // blue background
    expect(insideBox).not.toEqual(background);
  });
});
