import { z } from "zod";

const State = z.enum(["available", "partial", "unavailable", "unsupported"]);
export const CodexSetupSkillSchema = z.object({
  name: z.string(), path: z.string(), enabled: z.boolean().nullable(),
  origin: z.enum(["native", "supplemental"]),
});
export const CodexSetupRuntimeSchema = z.object({
  state: State,
  components: z.object({ config: State, skills: State, hooks: State }),
  settings: z.object({ model: z.string().nullable(), provider: z.string().nullable(), reasoning: z.string().nullable(), approvalPolicy: z.string().nullable(), sandbox: z.string().nullable() }),
  skills: z.array(CodexSetupSkillSchema),
  hooks: z.array(z.object({ event: z.string(), sourcePath: z.string().nullable(), enabled: z.boolean().nullable(), trust: z.string().nullable() })),
  connections: z.array(z.object({ name: z.string(), transport: z.enum(["stdio", "http", "unknown"]), enabled: z.boolean().nullable(), authentication: z.literal("not_checked") })),
});
export type CodexSetupRuntime = z.infer<typeof CodexSetupRuntimeSchema>;
export const CodexSetupScanSchema = z.object({
  fingerprint: z.string(), cwd: z.string(),
  homes: z.object({ user: z.string(), codex: z.string(), realm: z.string() }),
  runtime: CodexSetupRuntimeSchema,
  sources: z.array(z.object({ path: z.string(), kind: z.enum(["config", "instructions", "memory", "skill", "skillRoot"]), state: z.enum(["present", "missing", "unreadable"]) })),
  warnings: z.array(z.string()),
});
export type CodexSetupScan = z.infer<typeof CodexSetupScanSchema>;
export const CodexSetupOverridesSchema = z.object({ model: z.string().nullable().optional(), provider: z.string().nullable().optional(), reasoning: z.string().nullable().optional(), approvalPolicy: z.string().nullable().optional(), sandbox: z.string().nullable().optional() });
export const CodexSetupBindingSchema = z.object({ profileId: z.string(), receiptId: z.string(), codexHome: z.string(), extraSkillRoots: z.array(z.string()), overrides: CodexSetupOverridesSchema, fingerprint: z.string(), appliedAt: z.number() });
export type CodexSetupBinding = z.infer<typeof CodexSetupBindingSchema>;
export const CodexSetupReceiptSchema = z.object({ receiptId: z.string(), applied: CodexSetupBindingSchema, previous: CodexSetupBindingSchema.nullable() });
