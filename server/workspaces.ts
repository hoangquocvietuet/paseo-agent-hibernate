import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];

/** Workspace descriptor fields this plugin reads (see note on `PaseoAgent` in hibernator.ts). */
export interface PaseoWorkspace {
  id: string;
  name: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  /** Present only for Paseo-owned worktrees, whose directory is deleted on archive. */
  worktreeSlug?: string;
  pinnedAt?: string | null;
  archivingAt?: string | null;
}

const runFile = promisify(execFile);
const PAGE_LIMIT = 200;

/** Active workspaces only; the daemon does not list archived ones. */
export async function listActiveWorkspaces(api: PaseoApi): Promise<PaseoWorkspace[]> {
  const workspaces: PaseoWorkspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.workspaces.list({
      page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
    });
    workspaces.push(...page.entries);
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return workspaces;
}

/**
 * Archive a workspace nothing uses any more, so it leaves the sidebar. Kept when pinned, when
 * any agent in it is still active, when it has terminals (archiving kills them), or when it is a
 * Paseo-owned worktree whose deletion would lose uncommitted work or a detached HEAD.
 * Returns why it was kept, or `null` once archived.
 */
export async function archiveWorkspaceIfUnused(
  api: PaseoApi,
  workspace: PaseoWorkspace,
  activeAgentWorkspaceIds: ReadonlySet<string>,
): Promise<string | null> {
  if (workspace.pinnedAt) return "pinned";
  if (workspace.archivingAt) return "already archiving";
  if (activeAgentWorkspaceIds.has(workspace.id)) return "has active agents";
  const terminals = await api.terminals.list({ workspaceId: workspace.id });
  if (terminals.entries.length > 0) return "has terminals";
  if (workspace.worktreeSlug) {
    const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
    const unsafe = await worktreeRemovalRisk(directory);
    if (unsafe) return unsafe;
  }
  const result = await api.workspaces.archive(workspace.id);
  if (result.error) throw new Error(result.error);
  return null;
}

/** Archiving a Paseo worktree force-removes its directory but keeps the branch. */
async function worktreeRemovalRisk(directory: string): Promise<string | null> {
  try {
    const status = await runFile("git", ["status", "--porcelain"], { cwd: directory, timeout: 30_000 });
    if (status.stdout.trim()) return "worktree has uncommitted changes";
    await runFile("git", ["symbolic-ref", "-q", "HEAD"], { cwd: directory, timeout: 30_000 });
    return null;
  } catch {
    return "worktree state unknown or HEAD detached";
  }
}
