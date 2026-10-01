import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AgentHistorySchema,
  HibernatedAgentSchema,
  type AgentHistory,
  type HibernatedAgent,
} from "../shared/rpc";

const RegistryFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(HibernatedAgentSchema),
});

export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function defaultRegistryPath(): string {
  return join(paseoHome(), "plugin-data", "agent-hibernate", "hibernated.json");
}

/**
 * Agents this plugin archived, plus the chat history captured before archiving (reading an
 * archived agent's timeline would load its provider session again). Survives plugin reloads and
 * daemon restarts.
 */
export class HibernationRegistry {
  private entries: Promise<Map<string, HibernatedAgent>> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<HibernatedAgent[]> {
    const entries = await this.load();
    return [...entries.values()].sort((a, b) => b.hibernatedAt.localeCompare(a.hibernatedAt));
  }

  async get(agentId: string): Promise<HibernatedAgent | null> {
    return (await this.load()).get(agentId) ?? null;
  }

  async put(entry: HibernatedAgent): Promise<void> {
    (await this.load()).set(entry.agentId, entry);
    await this.persist();
  }

  /** No-op when the entry is gone; callers race with restores done elsewhere. */
  async update(agentId: string, patch: Partial<Omit<HibernatedAgent, "agentId">>): Promise<void> {
    const entries = await this.load();
    const current = entries.get(agentId);
    if (!current) return;
    entries.set(agentId, { ...current, ...patch });
    await this.persist();
  }

  async remove(agentIds: readonly string[]): Promise<void> {
    const entries = await this.load();
    let changed = false;
    for (const agentId of agentIds) changed = entries.delete(agentId) || changed;
    if (changed) await this.persist();
    await Promise.all(agentIds.map((agentId) => rm(this.historyPath(agentId), { force: true })));
  }

  async putHistory(agentId: string, history: AgentHistory): Promise<void> {
    await writeAtomic(this.historyPath(agentId), JSON.stringify(history));
  }

  /** `null` when missing or stored in an older shape; callers capture it again. */
  async readHistory(agentId: string): Promise<AgentHistory | null> {
    const raw = await readOptional(this.historyPath(agentId));
    if (raw === null) return null;
    const parsed = AgentHistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  private historyPath(agentId: string): string {
    return join(dirname(this.path), "history", `${encodeURIComponent(agentId)}.json`);
  }

  private load(): Promise<Map<string, HibernatedAgent>> {
    this.entries ??= this.read();
    return this.entries;
  }

  private async read(): Promise<Map<string, HibernatedAgent>> {
    const raw = await readOptional(this.path);
    if (raw === null) return new Map();
    const file = RegistryFileSchema.parse(JSON.parse(raw));
    return new Map(file.entries.map((entry) => [entry.agentId, entry]));
  }

  /** Serialized rewrite of the whole file from the current in-memory state. */
  private persist(): Promise<void> {
    const write = this.writes.then(async () => {
      const entries = await this.load();
      await writeAtomic(
        this.path,
        JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2),
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);
}
