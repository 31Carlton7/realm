import { z } from "zod";
import { ulid } from "ulid";
export type Id = string;
export const newId = (): Id => ulid();
/** Crockford base32 ULID: 26 chars, no I/L/O/U. */
export const IdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Expected a 26-char ULID");
