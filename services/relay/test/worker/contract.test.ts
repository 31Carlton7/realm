import { env } from "cloudflare:workers";
import { describe } from "vitest";
import { relayContract } from "../shared/contract";
import { connect } from "./connect";

describe("the Worker and its Durable Object", () => {
  relayContract(() => ({ connect, apnsOrigin: env.APNS_ORIGIN ?? "" }));
});
