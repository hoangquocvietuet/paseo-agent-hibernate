import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { WorkspaceRestore } from "../shared/rpc";

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
 */
export async function archiveWorkspaceIfUnused(
  api: PaseoApi,
  workspace: PaseoWorkspace,
  activeAgentWorkspaceIds: ReadonlySet<string>,
): Promise<{ keptBecause: string } | { restore: WorkspaceRestore }> {
  if (workspace.pinnedAt) return { keptBecause: "pinned" };
  if (workspace.archivingAt) return { keptBecause: "already archiving" };
  if (activeAgentWorkspaceIds.has(workspace.id)) return { keptBecause: "has active agents" };
  const terminals = await api.terminals.list({ workspaceId: workspace.id });
  if (terminals.entries.length > 0) return { keptBecause: "has terminals" };
  const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
  const worktree = workspace.worktreeSlug ? await inspectWorktree(directory) : null;
  if (typeof worktree === "string") return { keptBecause: worktree };
  const result = await api.workspaces.archive(workspace.id);
  if (result.error) throw new Error(result.error);
  return { restore: { directory, worktree } };
}

/**
 * Archiving a Paseo worktree force-removes its directory but keeps the branch. Returns why it
 * must not be removed, or the branch and main repository that recreate it.
 */
async function inspectWorktree(directory: string): Promise<WorkspaceRestore["worktree"] | string> {
  try {
    const status = await git(directory, ["status", "--porcelain"]);
    if (status) return "worktree has uncommitted changes";
    const branch = await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const commonDir = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return { branch, repoRoot: dirname(commonDir) };
  } catch {
    return "worktree state unknown or HEAD detached";
  }
}

/**
 * Unarchive a workspace like the app's Unarchive / Restore branch: recreate a deleted worktree
 * from its branch, then open its directory, which unarchives the workspace recorded there.
 * Opening must give back this workspace; anything else it activated is archived again.
 */
export async function reopenWorkspace(
  api: PaseoApi,
  workspaceId: string,
  restore: WorkspaceRestore,
): Promise<void> {
  const active = await listActiveWorkspaces(api);
  if (active.some((workspace) => workspace.workspaceDirectory === restore.directory)) {
    throw new Error(`Another workspace is open at ${restore.directory}`);
  }
  if (!(await isDirectory(restore.directory))) {
    if (!restore.worktree) throw new Error(`Directory not found: ${restore.directory}`);
    const { branch, repoRoot } = restore.worktree;
    // A stale registration of the removed path would block `worktree add`.
    await git(repoRoot, ["worktree", "prune"]);
    await git(repoRoot, ["worktree", "add", restore.directory, branch]);
  }
  const opened = await api.workspaces.open(restore.directory);
  if (opened.id !== workspaceId) {
    await api.workspaces.archive(opened.id);
    throw new Error(`${restore.directory} now belongs to another workspace`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, { cwd, timeout: 60_000 });
  return stdout.trim();
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}
