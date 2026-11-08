import type { PlatformId } from "@studio/core";
import { PublishError } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

/** Calls an HTTP API and returns parsed JSON, raising PublishError on failure. */
export async function requestJson<T>(
  fetchFn: FetchLike,
  platform: PlatformId,
  url: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (cause) {
    throw new PublishError(platform, `network error calling ${redact(url)}: ${(cause as Error).message}`, {
      retryable: true,
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new PublishError(platform, `${init.method ?? "GET"} ${redact(url)} failed with ${res.status}: ${text.slice(0, 500)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  const data = (text ? JSON.parse(text) : {}) as T;
  return { data, headers: res.headers, status: res.status };
}

export function form(params: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  return body;
}

/** Strips tokens and secrets from URLs before they reach logs or error messages. */
export function redact(url: string): string {
  return url.replace(/(access_token|client_secret|code)=[^&]+/g, "$1=***");
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
