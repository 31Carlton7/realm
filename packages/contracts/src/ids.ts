import { ulid } from "ulid";
export type Id = string;
export const newId = (): Id => ulid();
