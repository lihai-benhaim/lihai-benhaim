import type { FetchLike } from "../src/index.ts";

export interface Call {
  method: string;
  url: string;
  body: string | Uint8Array | null;
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response | { json: unknown; headers?: Record<string, string>; status?: number };

/** Minimal fetch double: routes by method + URL substring, records every call. */
export function fakeFetch(routes: [string, string | RegExp, Handler][]) {
  const calls: Call[] = [];
  const fn: FetchLike = async (input, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body instanceof URLSearchParams ? init.body.toString() : ((init.body as string | Uint8Array | undefined) ?? null);
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    const call: Call = { method, url: input, body, headers };
    calls.push(call);
    const route = routes.find(([m, pattern]) => m === method && (typeof pattern === "string" ? input.includes(pattern) : pattern.test(input)));
    if (!route) return new Response(`no route for ${method} ${input}`, { status: 404 });
    const out = route[2](call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  return { fn, calls };
}
