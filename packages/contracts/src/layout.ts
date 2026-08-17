import { z } from "zod";

export type Layout =
  | { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Layout[] }
  | { type: "leaf"; id: string; tabs: string[]; activeTab: string | null };

export const LayoutSchema: z.ZodType<Layout> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("split"), id: z.string(), dir: z.enum(["row", "col"]),
      sizes: z.array(z.number()), children: z.array(LayoutSchema) }),
    z.object({ type: z.literal("leaf"), id: z.string(), tabs: z.array(z.string()),
      activeTab: z.string().nullable() }),
  ]),
);
