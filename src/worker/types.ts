/** Hono context types shared by every route and middleware. `Env` comes from worker-configuration.d.ts. */
export type AppEnv = {
  Bindings: Env;
  Variables: { ownerId: string };
};
