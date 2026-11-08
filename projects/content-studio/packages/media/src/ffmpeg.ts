import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export const DEFAULT_BINARIES: FfmpegBinaries = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

export function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.split("\n").slice(-15).join("\n")}`));
    });
  });
}

export interface ProbeResult {
  width: number;
  height: number;
  durationSec: number | null;
}

export async function probe(path: string, bins: FfmpegBinaries = DEFAULT_BINARIES): Promise<ProbeResult> {
  const { stdout } = await run(bins.ffprobe, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    path,
  ]);
  const data = JSON.parse(stdout) as { streams?: { width: number; height: number }[]; format?: { duration?: string } };
  const s = data.streams?.[0];
  if (!s) throw new Error(`no video stream in ${path}`);
  const d = data.format?.duration ? Number(data.format.duration) : NaN;
  return { width: s.width, height: s.height, durationSec: Number.isFinite(d) ? d : null };
}

export async function fileFacts(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: info.size };
}

/** Escapes a value for use inside an ffmpeg filtergraph option. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

/**
 * Greedy word wrap. Hebrew and English words both break on spaces; a single
 * word longer than the line is kept whole rather than split mid-word.
 */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ([...line].length + 1 + [...word].length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

const RATIOS: [string, number][] = [
  ["9:16", 9 / 16],
  ["4:5", 4 / 5],
  ["1:1", 1],
  ["2:3", 2 / 3],
  ["16:9", 16 / 9],
  ["1.91:1", 1.91],
];

export function aspectLabel(width: number, height: number): string {
  const r = width / height;
  const best = RATIOS.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a));
  return Math.abs(best[1] - r) / best[1] < 0.02 ? best[0] : `${width}:${height}`;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "studio-render-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export { writeFile };
