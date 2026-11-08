/**
 * Platform registry: the single place that knows what each network accepts.
 *
 * Limits change over time. When a platform changes a limit, update it here and
 * everything else (agent prompt, validation, preview) follows. Values were
 * taken from each platform's publishing API docs; re-check them before relying
 * on an edge case (see docs/platforms.md).
 */

export const PLATFORM_IDS = [
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "x",
  "threads",
  "pinterest",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const CONTENT_FORMATS = [
  "story",
  "reel",
  "short",
  "feed_image",
  "carousel",
  "feed_video",
  "text",
  "pin",
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export type MediaKind = "none" | "image" | "video" | "image_or_video" | "images";

export interface FormatSpec {
  format: ContentFormat;
  /** Accepted aspect ratios, first one is preferred. Empty for text-only. */
  aspectRatios: string[];
  media: MediaKind;
  minVideoSeconds?: number;
  maxVideoSeconds?: number;
  minItems?: number;
  maxItems?: number;
  /** Max caption/body length in characters. */
  captionMaxChars: number;
  /** Max title length when the format has a separate title (YouTube, Pinterest). */
  titleMaxChars?: number;
  hashtagsMax?: number;
}

export type AdapterStatus = "native" | "planned";

export interface PlatformSpec {
  id: PlatformId;
  displayName: string;
  /** What kind of account the API can publish to. Shown to the user when linking. */
  accountRequirement: string;
  adapter: AdapterStatus;
  formats: FormatSpec[];
}

const PLATFORMS: Record<PlatformId, PlatformSpec> = {
  instagram: {
    id: "instagram",
    displayName: "Instagram",
    accountRequirement: "Professional account (Business or Creator). Personal accounts cannot publish through the API.",
    adapter: "native",
    formats: [
      { format: "story", aspectRatios: ["9:16"], media: "image_or_video", minVideoSeconds: 3, maxVideoSeconds: 60, captionMaxChars: 0 },
      { format: "reel", aspectRatios: ["9:16"], media: "video", minVideoSeconds: 3, maxVideoSeconds: 900, captionMaxChars: 2200, hashtagsMax: 30 },
      { format: "feed_image", aspectRatios: ["4:5", "1:1", "1.91:1"], media: "image", captionMaxChars: 2200, hashtagsMax: 30 },
      { format: "carousel", aspectRatios: ["4:5", "1:1"], media: "images", minItems: 2, maxItems: 10, captionMaxChars: 2200, hashtagsMax: 30 },
    ],
  },
  facebook: {
    id: "facebook",
    displayName: "Facebook",
    accountRequirement: "A Facebook Page you manage. Personal profiles cannot be published to through the API.",
    adapter: "planned",
    formats: [
      { format: "story", aspectRatios: ["9:16"], media: "image_or_video", maxVideoSeconds: 60, captionMaxChars: 0 },
      { format: "reel", aspectRatios: ["9:16"], media: "video", minVideoSeconds: 3, maxVideoSeconds: 90, captionMaxChars: 2200 },
      { format: "feed_image", aspectRatios: ["1:1", "4:5", "1.91:1"], media: "image", captionMaxChars: 63206 },
      { format: "feed_video", aspectRatios: ["16:9", "1:1", "4:5"], media: "video", captionMaxChars: 63206 },
      { format: "text", aspectRatios: [], media: "none", captionMaxChars: 63206 },
    ],
  },
  linkedin: {
    id: "linkedin",
    displayName: "LinkedIn",
    accountRequirement: "Personal profile (member) or a Company Page you administer.",
    adapter: "native",
    formats: [
      { format: "text", aspectRatios: [], media: "none", captionMaxChars: 3000 },
      { format: "feed_image", aspectRatios: ["1.91:1", "1:1", "4:5"], media: "image", captionMaxChars: 3000 },
      { format: "feed_video", aspectRatios: ["16:9", "1:1", "4:5", "9:16"], media: "video", minVideoSeconds: 3, maxVideoSeconds: 1800, captionMaxChars: 3000 },
    ],
  },
  tiktok: {
    id: "tiktok",
    displayName: "TikTok",
    accountRequirement: "Any TikTok account. Until the app passes TikTok's audit, API posts are private (only you can see them).",
    adapter: "planned",
    formats: [
      { format: "short", aspectRatios: ["9:16"], media: "video", minVideoSeconds: 3, maxVideoSeconds: 600, captionMaxChars: 2200 },
      { format: "carousel", aspectRatios: ["9:16", "1:1"], media: "images", minItems: 2, maxItems: 35, captionMaxChars: 2200 },
    ],
  },
  youtube: {
    id: "youtube",
    displayName: "YouTube",
    accountRequirement: "A YouTube channel. Until the Google project is verified, API uploads are private.",
    adapter: "planned",
    formats: [
      { format: "short", aspectRatios: ["9:16"], media: "video", maxVideoSeconds: 180, captionMaxChars: 5000, titleMaxChars: 100 },
      { format: "feed_video", aspectRatios: ["16:9"], media: "video", captionMaxChars: 5000, titleMaxChars: 100 },
    ],
  },
  x: {
    id: "x",
    displayName: "X",
    accountRequirement: "Any X account. Posting through the API needs a paid API tier.",
    adapter: "planned",
    formats: [
      { format: "text", aspectRatios: [], media: "none", captionMaxChars: 280 },
      { format: "feed_image", aspectRatios: ["16:9", "1:1"], media: "images", maxItems: 4, captionMaxChars: 280 },
      { format: "feed_video", aspectRatios: ["16:9", "1:1", "9:16"], media: "video", maxVideoSeconds: 140, captionMaxChars: 280 },
    ],
  },
  threads: {
    id: "threads",
    displayName: "Threads",
    accountRequirement: "A Threads profile.",
    adapter: "planned",
    formats: [
      { format: "text", aspectRatios: [], media: "none", captionMaxChars: 500 },
      { format: "feed_image", aspectRatios: ["4:5", "1:1"], media: "image", captionMaxChars: 500 },
      { format: "feed_video", aspectRatios: ["9:16", "4:5"], media: "video", maxVideoSeconds: 300, captionMaxChars: 500 },
      { format: "carousel", aspectRatios: ["4:5", "1:1"], media: "images", minItems: 2, maxItems: 20, captionMaxChars: 500 },
    ],
  },
  pinterest: {
    id: "pinterest",
    displayName: "Pinterest",
    accountRequirement: "A Pinterest business account.",
    adapter: "planned",
    formats: [
      { format: "pin", aspectRatios: ["2:3", "1:1"], media: "image_or_video", captionMaxChars: 500, titleMaxChars: 100 },
    ],
  },
};

export function getPlatform(id: PlatformId): PlatformSpec {
  return PLATFORMS[id];
}

export function listPlatforms(): PlatformSpec[] {
  return PLATFORM_IDS.map((id) => PLATFORMS[id]);
}

export function getFormatSpec(platform: PlatformId, format: ContentFormat): FormatSpec | undefined {
  return PLATFORMS[platform].formats.find((f) => f.format === format);
}

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

export function isContentFormat(value: string): value is ContentFormat {
  return (CONTENT_FORMATS as readonly string[]).includes(value);
}

/** Parses "instagram:story" into a target; throws on unknown platform/format pairs. */
export function parseTarget(value: string): { platform: PlatformId; format: ContentFormat } {
  const [platform, format] = value.trim().split(":");
  if (!platform || !format || !isPlatformId(platform) || !isContentFormat(format)) {
    throw new Error(`Invalid target "${value}". Use platform:format, e.g. instagram:story`);
  }
  if (!getFormatSpec(platform, format)) {
    throw new Error(`${getPlatform(platform).displayName} does not support the "${format}" format`);
  }
  return { platform, format };
}

/** Compact description of every platform's limits, for the agent's system prompt. */
export function describePlatformsForPrompt(): string {
  return listPlatforms()
    .map((p) => {
      const formats = p.formats
        .map((f) => {
          const parts = [
            `${f.format}: media=${f.media}`,
            f.aspectRatios.length ? `aspect=${f.aspectRatios.join("|")}` : null,
            f.maxVideoSeconds ? `video<=${f.maxVideoSeconds}s` : null,
            f.maxItems ? `items<=${f.maxItems}` : null,
            `caption<=${f.captionMaxChars} chars`,
            f.titleMaxChars ? `title<=${f.titleMaxChars}` : null,
            f.hashtagsMax ? `hashtags<=${f.hashtagsMax}` : null,
          ].filter(Boolean);
          return `  - ${parts.join(", ")}`;
        })
        .join("\n");
      return `${p.displayName} (${p.id}):\n${formats}`;
    })
    .join("\n");
}
