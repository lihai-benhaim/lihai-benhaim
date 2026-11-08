import type { MediaArtifact, Target } from "./draft.ts";
import type { Rendition } from "./plan.ts";
import { getFormatSpec, getPlatform } from "./platforms.ts";

export interface ValidationIssue {
  platform: string;
  format: string;
  severity: "error" | "warning";
  message: string;
}

/** Counts characters the way people (and most platforms) do: by code point. */
export function charCount(text: string): number {
  return [...text].length;
}

/** Full post text as it will be published: caption followed by hashtags. */
export function composeCaption(rendition: Pick<Rendition, "caption" | "hashtags">): string {
  const tags = rendition.hashtags.map((h) => `#${h.replace(/^#/, "").replace(/\s+/g, "")}`).join(" ");
  if (!tags) return rendition.caption;
  if (!rendition.caption) return tags;
  return `${rendition.caption}\n\n${tags}`;
}

/** Checks one rendition and the media chosen for it against the platform's limits. */
export function validateRendition(rendition: Rendition, media: MediaArtifact[]): ValidationIssue[] {
  const textIssues = validateRenditionText(rendition);
  if (textIssues.some((i) => i.message.includes("has no"))) return textIssues;
  return [...textIssues, ...validateRenditionMedia(rendition, media)];
}

/** Text-only checks (caption, hashtags, title), usable before any media exists. */
export function validateRenditionText(rendition: Rendition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = { platform: rendition.platform, format: rendition.format };
  const err = (message: string) => issues.push({ ...base, severity: "error", message });
  const warn = (message: string) => issues.push({ ...base, severity: "warning", message });

  const spec = getFormatSpec(rendition.platform, rendition.format);
  const platform = getPlatform(rendition.platform);
  if (!spec) {
    err(`${platform.displayName} has no "${rendition.format}" format`);
    return issues;
  }

  const text = composeCaption(rendition);
  if (spec.captionMaxChars === 0 && rendition.caption.trim()) {
    warn(`${platform.displayName} ${spec.format} has no caption; the text will not be published`);
  } else if (charCount(text) > spec.captionMaxChars) {
    err(`Caption is ${charCount(text)} characters; the limit is ${spec.captionMaxChars}`);
  }
  if (spec.hashtagsMax !== undefined && rendition.hashtags.length > spec.hashtagsMax) {
    err(`${rendition.hashtags.length} hashtags; the limit is ${spec.hashtagsMax}`);
  }
  if (spec.titleMaxChars !== undefined && rendition.title && charCount(rendition.title) > spec.titleMaxChars) {
    err(`Title is ${charCount(rendition.title)} characters; the limit is ${spec.titleMaxChars}`);
  }
  return issues;
}

/** Media checks: kind, item count, aspect ratio and video length. */
export function validateRenditionMedia(rendition: Rendition, media: MediaArtifact[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = { platform: rendition.platform, format: rendition.format };
  const err = (message: string) => issues.push({ ...base, severity: "error", message });
  const spec = getFormatSpec(rendition.platform, rendition.format);
  const platform = getPlatform(rendition.platform);
  if (!spec || spec.media === "none") return issues;
  if (media.length === 0) {
    err(`${platform.displayName} ${spec.format} needs media and none was rendered`);
    return issues;
  }
  const kinds = new Set(media.map((m) => m.kind));
  if (spec.media === "image" && !kinds.has("image")) err("Needs an image");
  if (spec.media === "video" && !kinds.has("video")) err("Needs a video");
  if (spec.media === "images" && !kinds.has("image")) err("Needs one or more images");
  if (spec.maxItems !== undefined && media.length > spec.maxItems) err(`${media.length} items; the limit is ${spec.maxItems}`);
  if (spec.minItems !== undefined && media.length < spec.minItems) err(`${media.length} item(s); needs at least ${spec.minItems}`);

  for (const m of media) {
    if (spec.aspectRatios.length && !spec.aspectRatios.includes(m.aspect)) {
      err(`Media is ${m.aspect}; ${platform.displayName} ${spec.format} accepts ${spec.aspectRatios.join(", ")}`);
    }
    if (m.kind === "video" && m.durationSec !== null) {
      if (spec.maxVideoSeconds !== undefined && m.durationSec > spec.maxVideoSeconds) {
        err(`Video is ${m.durationSec.toFixed(1)}s; the limit is ${spec.maxVideoSeconds}s`);
      }
      if (spec.minVideoSeconds !== undefined && m.durationSec < spec.minVideoSeconds) {
        err(`Video is ${m.durationSec.toFixed(1)}s; the minimum is ${spec.minVideoSeconds}s`);
      }
    }
  }
  return issues;
}

/** Picks the rendered media that fits a target (matching kind and aspect). */
export function mediaForTarget(target: Target, media: MediaArtifact[]): MediaArtifact[] {
  const spec = getFormatSpec(target.platform, target.format);
  if (!spec || spec.media === "none") return [];
  const kindOk = (m: MediaArtifact) =>
    spec.media === "image_or_video" ||
    (spec.media === "video" && m.kind === "video") ||
    ((spec.media === "image" || spec.media === "images") && m.kind === "image");
  const candidates = media.filter(kindOk);
  for (const aspect of spec.aspectRatios) {
    const match = candidates.filter((m) => m.aspect === aspect);
    if (match.length) {
      // Prefer video for image_or_video formats such as stories.
      const videos = match.filter((m) => m.kind === "video");
      const chosen = spec.media === "image_or_video" && videos.length ? videos : match;
      return spec.media === "images" ? chosen.slice(0, spec.maxItems) : chosen.slice(0, 1);
    }
  }
  return [];
}
