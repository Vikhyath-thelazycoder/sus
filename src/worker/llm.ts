import OpenAI from "openai";

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface LlmConfig {
  apiKey: string;
  baseURL: string;
  /** Tried in order; the next one is used on 429 / 5xx / network errors (PROJECT_PLAN §6.6). */
  models: string[];
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/**
 * Switching Groq → OpenAI is config only: LLM_BASE_URL, LLM_MODELS and the LLM_API_KEY secret.
 * `small` puts LLM_SMALL_MODEL first (guard, rewrite), still falling back to the others.
 */
export function llmConfigFromEnv(env: Env, size: "main" | "small" = "main"): LlmConfig {
  const models = env.LLM_MODELS.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const small = env.LLM_SMALL_MODEL;
  return {
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL,
    models: size === "small" && small ? [small, ...models.filter((m) => m !== small)] : models,
  };
}

/**
 * Groq reasoning models think before answering; keep that short and out of the reply. All three demo models accept
 * these (checked 2026-11-06). Sent as extra body fields, so OpenAI would need them removed (MVP).
 */
const REASONING = { reasoning_effort: "low", include_reasoning: false } as const;

export class LlmUnavailableError extends Error {
  constructor(cause: unknown) {
    super("All language models are unavailable", { cause });
  }
}

/** A stream failed after tokens were already sent; switching model now would duplicate text, so don't. */
export class StreamBrokenError extends Error {}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  if (err instanceof OpenAI.APIError) return err.status === 429 || (err.status ?? 0) >= 500;
  return false;
}

/** Run `call` against each model in turn until one succeeds. Non-retryable errors are thrown at once. */
export async function withFallback<T>(
  config: LlmConfig,
  call: (client: OpenAI, model: string) => Promise<T>,
): Promise<{ result: T; model: string }> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: 0, // the fallback chain is our retry policy
    timeout: config.timeoutMs ?? 30_000,
    fetch: config.fetch,
  });
  let lastError: unknown;
  for (const model of config.models) {
    try {
      return { result: await call(client, model), model };
    } catch (err) {
      if (!isRetryable(err)) throw err;
      lastError = err;
    }
  }
  throw new LlmUnavailableError(lastError);
}

/** One non-streaming completion. Used by helper steps (guard, rewrite) and tests. */
export async function complete(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<{ text: string; model: string }> {
  const { result, model } = await withFallback(config, (client, m) =>
    client.chat.completions.create({
      model: m,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 800,
      ...REASONING,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
  );
  return { text: result.choices[0]?.message.content ?? "", model };
}

/**
 * Streamed completion (SECURITY §7.4). Falls back to the next model only before the first token; `onToken` gets each
 * piece of text as it arrives. `maxTokens` includes the model's (low-effort) reasoning.
 */
export async function streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  onToken: (text: string) => void | Promise<void>,
  options: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
): Promise<{ text: string; model: string; finishReason: string | null }> {
  const { result, model } = await withFallback(config, async (client, m) => {
    // The SDK timeout stops at the response headers; this one also covers a stream that stalls midway (SECURITY §7.4).
    const deadline = AbortSignal.timeout(config.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const stream = await client.chat.completions.create(
      {
        model: m,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 1000,
        stream: true,
        ...REASONING,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      { signal },
    );
    let text = "";
    let finishReason: string | null = null;
    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const piece = choice?.delta?.content ?? "";
        if (piece) {
          text += piece;
          await onToken(piece);
        }
        finishReason = choice?.finish_reason ?? finishReason;
      }
    } catch (err) {
      if (text) throw new StreamBrokenError("Stream interrupted", { cause: err });
      if (deadline.aborted) throw new OpenAI.APIConnectionTimeoutError(); // retryable: try the next model
      throw err;
    }
    // The SDK ends an aborted stream quietly instead of throwing, so check the deadline here too.
    if (deadline.aborted) {
      if (text) throw new StreamBrokenError("Stream timed out");
      throw new OpenAI.APIConnectionTimeoutError();
    }
    return { text, finishReason };
  });
  return { ...result, model };
}
