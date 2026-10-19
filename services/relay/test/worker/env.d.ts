import type { Env as RelayEnv } from "../../src/env";

// `env` from cloudflare:test and cloudflare:workers is typed as Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}
