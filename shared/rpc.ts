import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const HibernatedAgentSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** The agent's `updatedAt` when it was archived. */
  lastActivityAt: z.string(),
  hibernatedAt: z.string(),
  reason: z.enum(["idle", "manual"]),
  /** Direct sub-agents the daemon archived together with this agent. */
  subagentCount: z.number().int().nonnegative().default(0),
});
export type HibernatedAgent = z.infer<typeof HibernatedAgentSchema>;

export const listRpc = defineRpc({
  name: "hibernate.list",
  input: z.object({}),
  output: z.object({
    entries: z.array(HibernatedAgentSchema),
    lastScanAt: z.string().nullable(),
    enabled: z.boolean(),
    idleHours: z.number(),
  }),
});

export const scanRpc = defineRpc({
  name: "hibernate.scan",
  input: z.object({}),
  output: z.object({ hibernated: z.array(z.string()) }),
});

export const hibernateAgentRpc = defineRpc({
  name: "hibernate.agent",
  input: z.object({ agentId: z.string().min(1) }),
  output: HibernatedAgentSchema,
});

export const resumeRpc = defineRpc({
  name: "hibernate.resume",
  input: z.object({ agentId: z.string().min(1), prompt: z.string().trim().min(1) }),
  output: z.object({ agentId: z.string() }),
});

export const forgetRpc = defineRpc({
  name: "hibernate.forget",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({}),
});
