import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HibernatedAgentSchema, type HibernatedAgent } from "../shared/rpc";

const RegistryFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(HibernatedAgentSchema),
});

export function defaultRegistryPath(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "agent-hibernate", "hibernated.json");
}

/** Agents this plugin archived. Survives plugin reloads and daemon restarts. */
export class HibernationRegistry {
  private entries: Promise<Map<string, HibernatedAgent>> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<HibernatedAgent[]> {
    const entries = await this.load();
    return [...entries.values()].sort((a, b) => b.hibernatedAt.localeCompare(a.hibernatedAt));
  }

  async put(entry: HibernatedAgent): Promise<void> {
    (await this.load()).set(entry.agentId, entry);
    await this.persist();
  }

  async remove(agentIds: readonly string[]): Promise<void> {
    const entries = await this.load();
    let changed = false;
    for (const agentId of agentIds) changed = entries.delete(agentId) || changed;
    if (changed) await this.persist();
  }

  private load(): Promise<Map<string, HibernatedAgent>> {
    this.entries ??= this.read();
    return this.entries;
  }

  private async read(): Promise<Map<string, HibernatedAgent>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const file = RegistryFileSchema.parse(JSON.parse(raw));
    return new Map(file.entries.map((entry) => [entry.agentId, entry]));
  }

  /** Serialized, atomic rewrite of the whole file from the current in-memory state. */
  private persist(): Promise<void> {
    const write = this.writes.then(async () => {
      const entries = await this.load();
      const body = JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2);
      const temporary = `${this.path}.${process.pid}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, body, "utf8");
      await rename(temporary, this.path);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
