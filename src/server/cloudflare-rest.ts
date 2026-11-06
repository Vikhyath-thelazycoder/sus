/**
 * Cloudflare D1, Vectorize, Workers AI and KV over the REST API, shaped like the Worker bindings the app already
 * uses. This lets the demo run the same Hono app on Render (no 10 ms CPU limit) while the data stays on Cloudflare.
 * Only the methods the app calls are implemented.
 */
export interface CfRestConfig {
  accountId: string;
  apiToken: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

export class CfApiError extends Error {}

function client(cfg: CfRestConfig) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}`;
  const doFetch = cfg.fetch ?? fetch;
  return async function call<T>(path: string, init: { method?: string; body?: BodyInit; contentType?: string } = {}): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        ...(init.body !== undefined ? { "Content-Type": init.contentType ?? "application/json" } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(20_000), // a stalled Cloudflare call must not hang the request
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message?: string }[] };
    if (!res.ok || !data.success) {
      // Message only: never echo the request (it may contain the token's scope or user text).
      throw new CfApiError(`Cloudflare API ${res.status}: ${data.errors?.[0]?.message ?? "request failed"}`);
    }
    return data.result as T;
  };
}

// ---------------------------------------------------------------- D1

interface D1RestResult {
  results: Json[];
  success: boolean;
  meta: Json;
}

class RestStatement {
  constructor(
    readonly db: RestD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new RestStatement(this.db, this.sql, params);
  }
  async all<T = Json>() {
    const [r] = await this.db.batch([this]);
    return r as unknown as { results: T[]; success: boolean; meta: Json };
  }
  async first<T = Json>(column?: string): Promise<T | null> {
    const row = (await this.all<Json>()).results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async run() {
    return this.all();
  }
}

/** Note: REST sends JSON numbers as SQLite REAL; integer columns convert them back losslessly. */
export class RestD1 {
  private call: ReturnType<typeof client>;
  constructor(
    cfg: CfRestConfig,
    private databaseId: string,
  ) {
    this.call = client(cfg);
  }
  prepare(sql: string) {
    return new RestStatement(this, sql);
  }
  async batch(statements: RestStatement[]): Promise<D1RestResult[]> {
    if (!statements.length) return [];
    return this.call<D1RestResult[]>(`/d1/database/${this.databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ batch: statements.map((s) => ({ sql: s.sql, params: s.params })) }),
    });
  }
}

// ---------------------------------------------------------------- Vectorize (v2)

export class RestVectorize {
  private call: ReturnType<typeof client>;
  constructor(
    cfg: CfRestConfig,
    private index: string,
  ) {
    this.call = client(cfg);
  }
  upsert(vectors: { id: string; values: number[]; metadata?: Json; namespace?: string }[]) {
    return this.call<{ mutationId: string }>(`/vectorize/v2/indexes/${this.index}/upsert`, {
      method: "POST",
      body: vectors.map((v) => JSON.stringify(v)).join("\n"),
      contentType: "application/x-ndjson",
    });
  }
  describe() {
    return this.call<{ vectorCount: number; processedUpToDatetime: string | null; processedUpToMutation: string | null }>(
      `/vectorize/v2/indexes/${this.index}/info`,
    );
  }
  deleteByIds(ids: string[]) {
    return this.call<{ mutationId: string }>(`/vectorize/v2/indexes/${this.index}/delete_by_ids`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  }
  query(vector: number[], options: { topK?: number; filter?: Json; returnMetadata?: boolean | string; returnValues?: boolean; namespace?: string } = {}) {
    const returnMetadata = options.returnMetadata === true ? "all" : options.returnMetadata === false ? "none" : options.returnMetadata;
    return this.call<{ count: number; matches: { id: string; score: number; metadata?: Json }[] }>(
      `/vectorize/v2/indexes/${this.index}/query`,
      { method: "POST", body: JSON.stringify({ vector, ...options, ...(returnMetadata ? { returnMetadata } : {}) }) },
    );
  }
}

// ---------------------------------------------------------------- Workers AI

export class RestAi {
  private call: ReturnType<typeof client>;
  constructor(cfg: CfRestConfig) {
    this.call = client(cfg);
  }
  run(model: string, input: unknown) {
    if (!/^@cf\/[\w.-]+\/[\w.-]+$/.test(model)) throw new CfApiError("Invalid model name");
    return this.call<unknown>(`/ai/run/${model}`, { method: "POST", body: JSON.stringify(input) });
  }
}

// ---------------------------------------------------------------- KV

export class RestKv {
  constructor(
    private cfg: CfRestConfig,
    private namespaceId: string,
  ) {}
  private valueUrl(key: string) {
    return `https://api.cloudflare.com/client/v4/accounts/${this.cfg.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${encodeURIComponent(key)}`;
  }
  /** KV values are returned raw (not wrapped in {success,result}), so this one bypasses `call`. */
  async get(key: string): Promise<string | null> {
    const res = await (this.cfg.fetch ?? fetch)(this.valueUrl(key), { headers: { Authorization: `Bearer ${this.cfg.apiToken}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new CfApiError(`Cloudflare API ${res.status}: KV read failed`);
    return res.text();
  }
  async put(key: string, value: string, options: { expirationTtl?: number } = {}) {
    const ttl = options.expirationTtl ? `?expiration_ttl=${Math.max(60, Math.floor(options.expirationTtl))}` : "";
    const res = await (this.cfg.fetch ?? fetch)(this.valueUrl(key) + ttl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.cfg.apiToken}`, "Content-Type": "text/plain" },
      body: value,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new CfApiError(`Cloudflare API ${res.status}: KV write failed`);
  }
  async delete(key: string) {
    const res = await (this.cfg.fetch ?? fetch)(this.valueUrl(key), { method: "DELETE", headers: { Authorization: `Bearer ${this.cfg.apiToken}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok && res.status !== 404) throw new CfApiError(`Cloudflare API ${res.status}: KV delete failed`);
  }
}
