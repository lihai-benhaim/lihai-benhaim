import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ContentPlan, Scene } from "@studio/core";
import {
  DEFAULT_BINARIES,
  aspectLabel,
  escapeFilterValue,
  fileFacts,
  probe,
  run,
  withTempDir,
  wrapText,
  writeFile,
  type FfmpegBinaries,
} from "./ffmpeg.ts";

export interface SceneAsset {
  requestId: string;
  kind: "image" | "video";
  path: string;
}

export interface RenderInput {
  plan: ContentPlan;
  assets: SceneAsset[];
  /** Directory the rendered files are written to. */
  outDir: string;
}

export interface RenderedFile {
  kind: "image" | "video";
  mimeType: string;
  path: string;
  width: number;
  height: number;
  durationSec: number | null;
  aspect: string;
  sha256: string;
  sizeBytes: number;
}

export interface MediaRenderer {
  render(input: RenderInput): Promise<RenderedFile[]>;
}

export interface FfmpegRendererOptions {
  /** A font with Hebrew glyphs, e.g. Noto Sans Hebrew or DejaVu Sans. */
  fontFile: string;
  binaries?: FfmpegBinaries;
  fps?: number;
  /** Optional background music, looped and faded out. */
  musicPath?: string | null;
}

const STORY = { width: 1080, height: 1920 };
const COVER = { width: 1080, height: 1350 };

/**
 * Renders a storyboard into:
 *  - a 9:16 H.264 video (stories, reels, shorts, LinkedIn video), and
 *  - a 4:5 cover image of the first scene (feed posts).
 *
 * Photos get a slow zoom, text sits in a translucent box in the safe area
 * (clear of the story UI at the top and bottom). Text is shaped with
 * fribidi/harfbuzz, so Hebrew renders right-to-left correctly; the ffmpeg
 * build must include --enable-libfribidi (Debian/Ubuntu packages do).
 */
export class FfmpegRenderer implements MediaRenderer {
  private readonly bins: FfmpegBinaries;
  private readonly fps: number;
  private readonly fontFile: string;
  private readonly musicPath: string | null;

  constructor(opts: FfmpegRendererOptions) {
    this.bins = opts.binaries ?? DEFAULT_BINARIES;
    this.fps = opts.fps ?? 30;
    this.fontFile = opts.fontFile;
    this.musicPath = opts.musicPath ?? null;
  }

  async render(input: RenderInput): Promise<RenderedFile[]> {
    const scenes = input.plan.storyboard.scenes;
    if (scenes.length === 0) throw new Error("storyboard has no scenes");
    await mkdir(input.outDir, { recursive: true });
    const byRequest = new Map(input.assets.map((a) => [a.requestId, a]));

    return withTempDir(async (tmp) => {
      const videoPath = join(input.outDir, "story-9x16.mp4");
      await this.renderVideo(scenes, byRequest, videoPath, tmp);
      const coverPath = join(input.outDir, "cover-4x5.jpg");
      await this.renderStill(scenes[0]!, byRequest, coverPath, tmp);
      return Promise.all([this.describe(videoPath, "video", "video/mp4"), this.describe(coverPath, "image", "image/jpeg")]);
    });
  }

  private async describe(path: string, kind: "image" | "video", mimeType: string): Promise<RenderedFile> {
    const [info, facts] = await Promise.all([probe(path, this.bins), fileFacts(path)]);
    return {
      kind,
      mimeType,
      path,
      width: info.width,
      height: info.height,
      durationSec: kind === "video" ? info.durationSec : null,
      aspect: aspectLabel(info.width, info.height),
      ...facts,
    };
  }

  private async textFilter(scene: Scene, width: number, tmp: string, index: number, fadeIn: boolean): Promise<string | null> {
    const text = scene.overlayText.trim();
    if (!text) return null;
    const fontSize = Math.round(width / 16);
    const textPath = join(tmp, `text-${index}.txt`);
    await writeFile(textPath, wrapText(text, 22), "utf8");
    return [
      `drawtext=fontfile='${escapeFilterValue(this.fontFile)}'`,
      `textfile='${escapeFilterValue(textPath)}'`,
      `fontsize=${fontSize}`,
      "fontcolor=white",
      "box=1",
      "boxcolor=black@0.45",
      `boxborderw=${Math.round(fontSize * 0.45)}`,
      `line_spacing=${Math.round(fontSize * 0.25)}`,
      "text_align=C",
      "x=(w-text_w)/2",
      "y=h*0.68-text_h/2",
      ...(fadeIn ? ["alpha='min(1,t/0.4)'"] : []),
    ].join(":");
  }

  private sceneInput(scene: Scene, assets: Map<string, SceneAsset>, size: { width: number; height: number }): string[] {
    const asset = scene.assetRequestId ? assets.get(scene.assetRequestId) : undefined;
    if (asset?.kind === "video") return ["-t", String(scene.durationSec), "-i", asset.path];
    if (asset?.kind === "image") return ["-i", asset.path];
    const color = (scene.background ?? "#101828").replace("#", "0x");
    return ["-f", "lavfi", "-t", String(scene.durationSec), "-i", `color=c=${color}:s=${size.width}x${size.height}:r=${this.fps}`];
  }

  private sceneBase(scene: Scene, assets: Map<string, SceneAsset>, input: number, size: { width: number; height: number }, still: boolean): string {
    const { width: W, height: H } = size;
    const asset = scene.assetRequestId ? assets.get(scene.assetRequestId) : undefined;
    const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    if (asset?.kind === "image" && !still) {
      // Slow zoom ("Ken Burns"): upscale first so zoompan does not jitter.
      const frames = Math.round(scene.durationSec * this.fps);
      const bigW = Math.round((W * 1.25) / 2) * 2;
      const bigH = Math.round((H * 1.25) / 2) * 2;
      const step = (0.12 / frames).toFixed(5);
      return `[${input}:v]${cover(bigW, bigH)},zoompan=z='min(zoom+${step},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${this.fps},setsar=1,format=yuv420p`;
    }
    if (asset?.kind === "video" && !still) {
      return `[${input}:v]${cover(W, H)},fps=${this.fps},tpad=stop_mode=clone:stop_duration=${scene.durationSec},trim=duration=${scene.durationSec},setpts=PTS-STARTPTS,setsar=1,format=yuv420p`;
    }
    return `[${input}:v]${cover(W, H)},setsar=1,format=yuv420p`;
  }

  private async renderVideo(scenes: Scene[], assets: Map<string, SceneAsset>, out: string, tmp: string): Promise<void> {
    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    const filters: string[] = [];
    for (const [i, scene] of scenes.entries()) {
      args.push(...this.sceneInput(scene, assets, STORY));
      const text = await this.textFilter(scene, STORY.width, tmp, i, true);
      filters.push(`${this.sceneBase(scene, assets, i, STORY, false)}${text ? `,${text}` : ""}[v${i}]`);
    }
    const total = scenes.reduce((s, x) => s + x.durationSec, 0);
    filters.push(`${scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0[outv]`);

    const audioInput = scenes.length;
    if (this.musicPath) {
      args.push("-stream_loop", "-1", "-i", this.musicPath);
      filters.push(`[${audioInput}:a]atrim=0:${total},afade=t=out:st=${Math.max(0, total - 1)}:d=1[outa]`);
    } else {
      // Silent track: some platforms handle audio-less uploads poorly.
      args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=44100:cl=stereo");
    }

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[outv]",
      "-map", this.musicPath ? "[outa]" : `${audioInput}:a`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(this.fps),
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-t", String(total),
      out,
    );
    await run(this.bins.ffmpeg, args);
  }

  private async renderStill(scene: Scene, assets: Map<string, SceneAsset>, out: string, tmp: string): Promise<void> {
    const args = ["-y", "-hide_banner", "-loglevel", "error", ...this.sceneInput(scene, assets, COVER)];
    const text = await this.textFilter(scene, COVER.width, tmp, 999, false);
    const filter = `${this.sceneBase(scene, assets, 0, COVER, true)}${text ? `,${text}` : ""}[out]`;
    args.push("-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out);
    await run(this.bins.ffmpeg, args);
  }
}
