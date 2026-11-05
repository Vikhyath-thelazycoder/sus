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

/** Switching Groq → OpenAI is config only: LLM_BASE_URL, LLM_MODELS and the LLM_API_KEY secret. */
export function llmConfigFromEnv(env: Env): LlmConfig {
  return {
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL,
    models: env.LLM_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  };
}

export class LlmUnavailableError extends Error {
  constructor(cause: unknown) {
    super("All language models are unavailable", { cause });
  }
}

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
    }),
  );
  return { text: result.choices[0]?.message.content ?? "", model };
}
