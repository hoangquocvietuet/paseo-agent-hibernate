import type { PaseoAgent, PaseoAgentListOptions, PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { HibernatedAgent } from "../shared/rpc";
import { hibernateSettings } from "../shared/settings";
import type { HibernationRegistry } from "./registry";

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

export class Hibernator {
  private api: PaseoApi | null = null;
  private lastScanAt: string | null = null;
  private scanning: Promise<string[]> | null = null;
  /** Last session open or turn per agent, observed through lifecycle hooks. */
  private readonly touchedAtMs = new Map<string, number>();
  private readonly startedAtMs = Date.now();

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

  touch(agentId: string): void {
    this.touchedAtMs.set(agentId, Date.now());
  }

  /** Periodic entry point: honors the enabled switch and the plugin-start grace period. */
  async scanIfEnabled(): Promise<string[]> {
    if (!this.api) return [];
    const config = await this.readConfig();
    if (!config.enabled) return [];
    return this.scan(this.api, { graceSinceStart: true });
  }

  /** Manual scans skip the start grace: the user asked for it now. */
  scan(api: PaseoApi, options: { graceSinceStart: boolean } = { graceSinceStart: false }) {
    this.attach(api);
    this.scanning ??= this.runScan(api, options.graceSinceStart).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async list(api: PaseoApi) {
    this.attach(api);
    const [config, entries] = await Promise.all([this.readConfig(), this.registry.list()]);
    const stale = await this.findRestoredOrDeleted(api, entries);
    await this.registry.remove(stale);
    return {
      entries: entries.filter((entry) => !stale.includes(entry.agentId)),
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
    return this.archive(api, agent, "manual");
  }

  async resume(api: PaseoApi, agentId: string, prompt: string): Promise<void> {
    this.attach(api);
    // The daemon unarchives and resumes an archived agent when it receives a prompt. Its
    // sub-agents stay archived until it prompts them, which unarchives them the same way.
    await api.agents.ref(agentId).send(prompt);
    this.touch(agentId);
    await this.registry.remove([agentId]);
  }

  private async runScan(api: PaseoApi, graceSinceStart: boolean): Promise<string[]> {
    const config = await this.readConfig();
    const cutoffMs = Date.now() - config.idleHours * HOUR_MS;
    this.lastScanAt = new Date().toISOString();
    if (graceSinceStart && this.startedAtMs > cutoffMs) return [];

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
      if (this.isFamilyHibernatable(agent, descendants, cutoffMs)) candidates.push(agent);
    }

    const hibernated: string[] = [];
    for (const candidate of candidates) {
      try {
        // Archiving cancels active runs in the whole family, so re-check right before acting.
        const fresh = await fetchAgent(api, candidate.id);
        if (!fresh || parentAgentId(fresh)) continue;
        if (!this.isFamilyHibernatable(fresh, await listDescendants(api, fresh.id), cutoffMs)) {
          continue;
        }
        await this.archive(api, fresh, "idle");
        hibernated.push(fresh.id);
      } catch (error) {
        console.error(`Failed to hibernate agent ${candidate.id}`, error);
      }
    }
    if (hibernated.length > 0) console.log(`Hibernated ${hibernated.length} agent(s)`, hibernated);
    return hibernated;
  }

  /**
   * A main agent and its sub-agents idle together: any busy member blocks the family, and the
   * most recent activity of any member counts as the family's activity.
   */
  private isFamilyHibernatable(
    root: PaseoAgent,
    descendants: readonly PaseoAgent[],
    cutoffMs: number,
  ): boolean {
    if (root.archivedAt) return false;
    if (!(RESIDENT_STATUSES as readonly string[]).includes(root.status)) return false;
    const family = [root, ...descendants];
    if (family.some(isBusy)) return false;
    const lastTouchMs = Math.max(
      ...family.map((agent) =>
        Math.max(Date.parse(agent.updatedAt), this.touchedAtMs.get(agent.id) ?? 0),
      ),
    );
    return lastTouchMs <= cutoffMs;
  }

  private async archive(
    api: PaseoApi,
    agent: PaseoAgent,
    reason: HibernatedAgent["reason"],
  ): Promise<HibernatedAgent> {
    // The daemon cascades this to sub-agents; the plugin never archives them itself.
    await api.agents.ref(agent.id).archive();
    this.touchedAtMs.delete(agent.id);
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
      lastActivityAt: agent.updatedAt,
      hibernatedAt: new Date().toISOString(),
      reason,
      subagentCount: children.filter((child) => child.archivedAt).length,
    };
    await this.registry.put(entry);
    return entry;
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

/** Every page of the agent directory for one filter. Active agents unless the filter says otherwise. */
async function listAgents(
  api: PaseoApi,
  filter: PaseoAgentListOptions["filter"],
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
