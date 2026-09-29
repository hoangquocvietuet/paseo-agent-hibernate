import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const HibernatedAgentSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable().default(null),
  /** The plugin archived the workspace because nothing else used it. */
  workspaceArchivedByPlugin: z.boolean().default(false),
  /** Last conversation activity when the agent was archived. */
  lastActivityAt: z.string(),
  hibernatedAt: z.string(),
  reason: z.enum(["idle", "manual"]),
  /** Direct sub-agents the daemon archived together with this agent. */
  subagentCount: z.number().int().nonnegative().default(0),
  /** Prompt held until the user restores the archived workspace. */
  pendingPrompt: z.string().nullable().default(null),
});
export type HibernatedAgent = z.infer<typeof HibernatedAgentSchema>;

/** A hibernated agent as the dashboard sees it. */
export const HibernatedAgentViewSchema = HibernatedAgentSchema.extend({
  workspaceActive: z.boolean(),
});
export type HibernatedAgentView = z.infer<typeof HibernatedAgentViewSchema>;

export const HistoryItemSchema = z.object({
  timestamp: z.string(),
  kind: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const AgentHistorySchema = z.object({
  capturedAt: z.string(),
  /** Older items exist beyond the captured window. */
  truncated: z.boolean(),
  items: z.array(HistoryItemSchema),
});
export type AgentHistory = z.infer<typeof AgentHistorySchema>;

export const listRpc = defineRpc({
  name: "hibernate.list",
  input: z.object({}),
  output: z.object({
    entries: z.array(HibernatedAgentViewSchema),
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
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("resumed"), agentId: z.string() }),
    /** The prompt waits until the workspace is restored in the app. */
    z.object({ status: z.literal("restore_workspace"), agentId: z.string(), workspaceId: z.string() }),
  ]),
});

export const cancelResumeRpc = defineRpc({
  name: "hibernate.cancel_resume",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({}),
});

export const forgetRpc = defineRpc({
  name: "hibernate.forget",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({}),
});

/**
 * One page of saved chat, oldest first within the page. Pages walk backwards: pass the previous
 * page's `start` as `before` to get the messages above it; `start` 0 means nothing older is saved.
 */
export const historyRpc = defineRpc({
  name: "hibernate.history",
  input: z.object({
    agentId: z.string().min(1),
    before: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  output: AgentHistorySchema.extend({ start: z.number().int().nonnegative() }),
});
