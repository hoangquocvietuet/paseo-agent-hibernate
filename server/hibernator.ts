import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import type { AgentHistory, HibernatedAgent } from "../shared/rpc";
import { hibernateSettings } from "../shared/settings";
import { captureHistory } from "./history";
import type { HibernationRegistry } from "./registry";
import { archiveWorkspaceIfUnused, listActiveWorkspaces } from "./workspaces";

type PaseoApi = PluginHandlerContext["paseo"];

/**
 * The agent snapshot fields this plugin reads. Declared here because the plugin server runtime
 * only resolves `@getpaseo/plugin` and `zod`, so `@getpaseo/client` types cannot be imported.
 */
interface PaseoAgent {
  id: string;
  title: string | null;
  cwd: string;
  provider: string;
  model: string | null;
  workspaceId?: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  archivedAt?: string | null;
  activeTurn?: unknown;
  pendingPermissions: readonly unknown[];
  labels: Record<string, string>;
}

type AgentDirectoryFilter = { labels?: Record<string, string>; includeArchived?: boolean };

type HibernateConfig = { enabled: boolean; idleHours: number };

const HOUR_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 200;
/**
 * Loaded agents only: the daemon persists `closed` on shutdown and loads stored agents lazily,
 * so `idle`/`error` are the agents that still hold a provider session.
 */
const RESIDENT_STATUSES = ["idle", "error"] as const;
/**
 * Mirrors `PARENT_AGENT_ID_LABEL` in `@getpaseo/protocol/agent-labels`. Agents created through
 * `create_agent` carry it; archiving the parent makes the daemon archive (or detach) them too.
 */
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
/**
 * Timeline items that mean the agent or its user did something. Session reloads emit
 * `notification` and replayed `todo` rows, which must not count as activity.
 */
const CONVERSATION_ITEM_TYPES = new Set(["user_message", "assistant_message", "reasoning", "tool_call"]);
const TIMELINE_TAIL_LIMIT = 50;

export type ResumeResult =
  | { status: "resumed"; agentId: string }
  | { status: "restore_workspace"; agentId: string; workspaceId: string };

export class Hibernator {
  private api: PaseoApi | null = null;
  private lastScanAt: string | null = null;
  private scanning: Promise<string[]> | null = null;
  private resumingPending = false;

  constructor(
    private readonly settings: PluginSettings<typeof hibernateSettings.schema>,
    private readonly registry: HibernationRegistry,
  ) {}

  /**
   * The server entry receives no API handle; hooks and handlers do, and it is one connection
   * for the whole subprocess. The periodic scan uses the first one it sees.
   */
  attach(api: PaseoApi): void {
    this.api ??= api;
  }

  /** Periodic entry point: honors the enabled switch. */
  async scanIfEnabled(): Promise<string[]> {
    if (!this.api) return [];
    const config = await this.readConfig();
    if (!config.enabled) return [];
    return this.scan(this.api);
  }

  scan(api: PaseoApi): Promise<string[]> {
    this.attach(api);
    this.scanning ??= this.runScan(api).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async list(api: PaseoApi) {
    this.attach(api);
    const [config, entries, workspaces] = await Promise.all([
      this.readConfig(),
      this.registry.list(),
      listActiveWorkspaces(api),
    ]);
    const stale = await this.findRestoredOrDeleted(api, entries);
    await this.registry.remove(stale);
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    return {
      entries: entries
        .filter((entry) => !stale.includes(entry.agentId))
        .map((entry) => ({
          ...entry,
          workspaceActive: entry.workspaceId === null || activeWorkspaceIds.has(entry.workspaceId),
        })),
      lastScanAt: this.lastScanAt,
      enabled: config.enabled,
      idleHours: config.idleHours,
    };
  }

  async hibernateAgent(api: PaseoApi, agentId: string): Promise<HibernatedAgent> {
    this.attach(api);
    const agent = await fetchAgent(api, agentId);
    if (!agent) throw new Error(`Không tìm thấy agent ${agentId}.`);
    if (parentAgentId(agent)) {
      throw new Error("Đây là sub-agent: nó sẽ được archive cùng main agent.");
    }
    if (agent.archivedAt) throw new Error("Agent đã được archive.");
    const descendants = await listDescendants(api, agent.id);
    if ([agent, ...descendants].some(isBusy)) {
      throw new Error("Agent hoặc sub-agent của nó đang chạy hay chờ duyệt quyền.");
    }
    const entry = await this.archive(api, agent, await lastActivityMs(api, agent), "manual");
    await this.archiveUnusedWorkspaces(api);
    return (await this.registry.get(agent.id)) ?? entry;
  }

  /**
   * The daemon unarchives and resumes an archived agent when it receives a prompt, but leaves
   * its workspace archived. The plugin API cannot restore a workspace (only the app's recovery
   * view can), so the prompt waits until the user restores it there; `resumePending` sends it.
   * Sub-agents stay archived until the main agent prompts them, which unarchives them too.
   */
  async resume(api: PaseoApi, agentId: string, prompt: string): Promise<ResumeResult> {
    this.attach(api);
    const agent = await fetchAgent(api, agentId);
    if (!agent) throw new Error(`Không tìm thấy agent ${agentId}.`);
    const workspaceId = agent.workspaceId ?? null;
    if (workspaceId) {
      const workspaces = await listActiveWorkspaces(api);
      if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
        await this.registry.update(agentId, { pendingPrompt: prompt });
        return { status: "restore_workspace", agentId, workspaceId };
      }
    }
    await api.agents.ref(agentId).send(prompt);
    await this.registry.remove([agentId]);
    return { status: "resumed", agentId };
  }

  cancelResume(agentId: string): Promise<void> {
    return this.registry.update(agentId, { pendingPrompt: null });
  }

  /** Sends held prompts once their workspace is active again. Cheap when nothing is pending. */
  async resumePending(): Promise<void> {
    const api = this.api;
    if (!api || this.resumingPending) return;
    const pending = (await this.registry.list()).filter((entry) => entry.pendingPrompt);
    if (pending.length === 0) return;
    this.resumingPending = true;
    try {
      const activeWorkspaceIds = new Set((await listActiveWorkspaces(api)).map((w) => w.id));
      for (const entry of pending) {
        if (!entry.pendingPrompt || !entry.workspaceId || !activeWorkspaceIds.has(entry.workspaceId)) {
          continue;
        }
        try {
          await api.agents.ref(entry.agentId).send(entry.pendingPrompt);
          await this.registry.remove([entry.agentId]);
          console.log(`Resumed ${entry.agentId} after its workspace was restored`);
        } catch (error) {
          console.error(`Failed to resume ${entry.agentId}`, error);
        }
      }
    } finally {
      this.resumingPending = false;
    }
  }

  /**
   * Captured before archiving. Agents hibernated before capture existed are read once: that loads
   * the archived agent for history, so archive it again right away to close the session.
   */
  async history(api: PaseoApi, agentId: string): Promise<AgentHistory> {
    this.attach(api);
    const stored = await this.registry.readHistory(agentId);
    if (stored) return stored;
    const agent = await fetchAgent(api, agentId);
    if (!agent) throw new Error(`Không tìm thấy agent ${agentId}.`);
    try {
      const history = await captureHistory(api, agentId);
      await this.registry.putHistory(agentId, history);
      return history;
    } finally {
      if (agent.archivedAt) await api.agents.ref(agentId).archive();
    }
  }

  private async runScan(api: PaseoApi): Promise<string[]> {
    const config = await this.readConfig();
    const cutoffMs = Date.now() - config.idleHours * HOUR_MS;
    this.lastScanAt = new Date().toISOString();

    // Collect before archiving: archiving removes rows from the paginated active listing.
    const agents = await listAgents(api, {});
    const childrenByParent = new Map<string, PaseoAgent[]>();
    for (const agent of agents) {
      const parentId = parentAgentId(agent);
      if (parentId) childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), agent]);
    }
    const candidates: PaseoAgent[] = [];
    for (const agent of agents) {
      if (parentAgentId(agent)) continue;
      const descendants = await collectDescendants(
        agent.id,
        async (parentId) => childrenByParent.get(parentId) ?? [],
      );
      const idleSinceMs = await familyIdleSinceMs(api, agent, descendants, cutoffMs);
      if (idleSinceMs !== null && idleSinceMs <= cutoffMs) candidates.push(agent);
    }

    const hibernated: string[] = [];
    for (const candidate of candidates) {
      try {
        // Archiving cancels active runs in the whole family, so re-check right before acting.
        const fresh = await fetchAgent(api, candidate.id);
        if (!fresh || parentAgentId(fresh)) continue;
        const descendants = await listDescendants(api, fresh.id);
        const idleSinceMs = await familyIdleSinceMs(api, fresh, descendants, cutoffMs);
        if (idleSinceMs === null || idleSinceMs > cutoffMs) continue;
        await this.archive(api, fresh, idleSinceMs, "idle");
        hibernated.push(fresh.id);
      } catch (error) {
        console.error(`Failed to hibernate agent ${candidate.id}`, error);
      }
    }
    if (hibernated.length > 0) console.log(`Hibernated ${hibernated.length} agent(s)`, hibernated);
    await this.archiveUnusedWorkspaces(api);
    return hibernated;
  }

  private async archive(
    api: PaseoApi,
    agent: PaseoAgent,
    lastActivity: number,
    reason: HibernatedAgent["reason"],
  ): Promise<HibernatedAgent> {
    // Read while the session is still loaded: afterwards reading it would load it again.
    const history = await captureHistory(api, agent.id).catch((error: unknown) => {
      console.error(`Failed to capture history of ${agent.id}`, error);
      return null;
    });
    const workspace = agent.workspaceId
      ? (await listActiveWorkspaces(api)).find((candidate) => candidate.id === agent.workspaceId)
      : undefined;
    // The daemon cascades this to sub-agents; the plugin never archives them itself.
    await api.agents.ref(agent.id).archive();
    const children = await listAgents(api, {
      labels: { [PARENT_AGENT_ID_LABEL]: agent.id },
      includeArchived: true,
    });
    const entry: HibernatedAgent = {
      agentId: agent.id,
      title: agent.title,
      cwd: agent.cwd,
      provider: agent.provider,
      model: agent.model,
      workspaceId: agent.workspaceId ?? null,
      workspaceName: workspace?.name ?? null,
      workspaceArchivedByPlugin: false,
      lastActivityAt: new Date(lastActivity).toISOString(),
      hibernatedAt: new Date().toISOString(),
      reason,
      subagentCount: children.filter((child) => child.archivedAt).length,
      pendingPrompt: null,
    };
    await this.registry.put(entry);
    if (history) await this.registry.putHistory(agent.id, history);
    return entry;
  }

  /**
   * Workspaces of hibernated agents leave the sidebar once nothing else uses them. Runs after
   * every scan, which also covers agents hibernated before this existed and workspaces whose
   * last other agent was hibernated later. Workspaces with a held prompt are left alone.
   */
  private async archiveUnusedWorkspaces(api: PaseoApi): Promise<void> {
    const entries = (await this.registry.list()).filter(
      (entry) => entry.workspaceId && !entry.workspaceArchivedByPlugin && !entry.pendingPrompt,
    );
    if (entries.length === 0) return;
    const [workspaces, agents] = await Promise.all([listActiveWorkspaces(api), listAgents(api, {})]);
    const occupiedWorkspaceIds = new Set(agents.flatMap((agent) => agent.workspaceId ?? []));
    for (const workspaceId of new Set(entries.map((entry) => entry.workspaceId))) {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) continue;
      try {
        const keptBecause = await archiveWorkspaceIfUnused(api, workspace, occupiedWorkspaceIds);
        if (keptBecause) continue;
        console.log(`Archived unused workspace ${workspace.name} (${workspace.id})`);
        for (const entry of entries.filter((candidate) => candidate.workspaceId === workspaceId)) {
          await this.registry.update(entry.agentId, {
            workspaceArchivedByPlugin: true,
            workspaceName: workspace.name,
          });
        }
      } catch (error) {
        console.error(`Failed to archive workspace ${workspace.id}`, error);
      }
    }
  }

  /** Entries restored elsewhere (Unarchive button, a prompt from another client) or deleted. */
  private async findRestoredOrDeleted(
    api: PaseoApi,
    entries: readonly HibernatedAgent[],
  ): Promise<string[]> {
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const agent = await fetchAgent(api, entry.agentId);
        return !agent || !agent.archivedAt ? entry.agentId : null;
      }),
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
  }

  private async readConfig(): Promise<HibernateConfig> {
    const state = await this.settings.read();
    if (state.status === "ready") return state.values;
    console.error(`Invalid hibernate settings, using defaults: ${state.error}`);
    return hibernateSettings.schema.parse({});
  }
}

function parentAgentId(agent: PaseoAgent): string | null {
  return agent.labels[PARENT_AGENT_ID_LABEL]?.trim() || null;
}

function isBusy(agent: PaseoAgent): boolean {
  return (
    agent.status === "running" ||
    agent.status === "initializing" ||
    !!agent.activeTurn ||
    agent.pendingPermissions.length > 0
  );
}

/**
 * When a main agent and its sub-agents last did anything, or `null` when the family cannot be
 * hibernated now (root not holding a session, or any member busy). Members whose `updatedAt` is
 * already past the cutoff skip the timeline read.
 */
async function familyIdleSinceMs(
  api: PaseoApi,
  root: PaseoAgent,
  descendants: readonly PaseoAgent[],
  cutoffMs: number,
): Promise<number | null> {
  if (root.archivedAt) return null;
  if (!(RESIDENT_STATUSES as readonly string[]).includes(root.status)) return null;
  const family = [root, ...descendants];
  if (family.some(isBusy)) return null;
  const activity = await Promise.all(
    family.map((agent) =>
      Date.parse(agent.updatedAt) <= cutoffMs ? Date.parse(agent.updatedAt) : lastActivityMs(api, agent),
    ),
  );
  return Math.max(...activity);
}

/**
 * Last conversation activity. `updatedAt` also moves on title, label and mode changes and when a
 * provider session reloads, so it only bounds activity from above. Unloaded agents keep that
 * bound: reading their timeline would load them.
 */
async function lastActivityMs(api: PaseoApi, agent: PaseoAgent): Promise<number> {
  if (!(RESIDENT_STATUSES as readonly string[]).includes(agent.status)) {
    return Date.parse(agent.updatedAt);
  }
  const tail = await api.agents
    .ref(agent.id)
    .timeline.refetch({ direction: "tail", limit: TIMELINE_TAIL_LIMIT });
  let latest = Date.parse(agent.lastUserMessageAt ?? agent.createdAt);
  for (const entry of tail.entries) {
    if (CONVERSATION_ITEM_TYPES.has(entry.item.type)) {
      latest = Math.max(latest, Date.parse(entry.timestamp));
    }
  }
  return latest;
}

/** Every page of the agent directory for one filter. Active agents unless the filter says otherwise. */
async function listAgents(
  api: PaseoApi,
  filter: AgentDirectoryFilter,
): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.agents.list({
      filter,
      page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
    });
    agents.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}

/** Active sub-agents at any depth, read fresh from the daemon. */
function listDescendants(api: PaseoApi, rootId: string): Promise<PaseoAgent[]> {
  return collectDescendants(rootId, (parentId) =>
    listAgents(api, { labels: { [PARENT_AGENT_ID_LABEL]: parentId } }),
  );
}

async function collectDescendants(
  rootId: string,
  childrenOf: (parentId: string) => Promise<readonly PaseoAgent[]>,
): Promise<PaseoAgent[]> {
  const descendants: PaseoAgent[] = [];
  const pending = [rootId];
  const seen = new Set(pending);
  for (let parentId = pending.pop(); parentId; parentId = pending.pop()) {
    for (const child of await childrenOf(parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      pending.push(child.id);
    }
  }
  return descendants;
}

/** `null` when the daemon no longer knows the agent; other failures propagate. */
async function fetchAgent(api: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  try {
    return (await api.agents.ref(agentId).refresh())?.agent ?? null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent not found")) return null;
    throw error;
  }
}
