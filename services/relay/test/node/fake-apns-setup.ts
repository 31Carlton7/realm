import type { TestProject } from "vitest/node";
import { startFakeApns } from "./fake-apns";

declare module "vitest" {
  export interface ProvidedContext {
    /** The fake APNs that this project's relay pushes to. */
    apnsOrigin: string;
    /** The .p8 the relay signs its APNs tokens with in tests. */
    apnsKeyP8: string;
  }
}

/** globalSetup for both projects: one fake APNs each, started before any relay is. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const apns = await startFakeApns();
  project.provide("apnsOrigin", apns.origin);
  project.provide("apnsKeyP8", apns.keyP8);
  return () => apns.close();
}
