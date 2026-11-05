import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Context } from "hono";

/** Generic messages only; details go to structured logs, never to the client (SECURITY §3.1, §12 #13). */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request failed" }, err.status);
  }
  console.error(JSON.stringify({ level: "error", path: c.req.path, error: String(err) }));
  return c.json({ error: "Something went wrong" }, 500);
};

/** Parse and validate a JSON body. Schemas should be `z.strictObject` so unknown fields are rejected. */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON" });
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HTTPException(400, { message: "Invalid request" });
  return result.data;
}
