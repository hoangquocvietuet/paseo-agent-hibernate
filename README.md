# paseo-agent-hibernate

A [Paseo](https://paseo.sh) plugin that frees agents idle for too long and lets you resume them from one dashboard.

Every 10 minutes the plugin archives main agents whose whole family (the agent and its sub-agents) has been idle for longer than the threshold (12 hours by default). Archiving closes the provider session and drops the retained timeline, so the memory goes back to the host. Archived agents stay listed in the plugin's dashboard, and **Tiếp tục** sends them a prompt, which makes the daemon unarchive and resume them.

## Behavior

- Only agents with a live session (`idle` or `error`) are considered. The daemon stores agents as `closed` on shutdown and loads them lazily, so unloaded agents are left alone.
- Sub-agents (agents carrying the `paseo.parent-agent-id` label) are never archived by the plugin. When the plugin archives a main agent, the daemon archives its sub-agents too (or detaches those with an open tab or in another workspace). A sub-agent reopens when its main agent prompts it.
- A family is skipped while any member is running, has an active turn, or waits for a permission.
- Idleness is measured from the newest conversation item (user message, assistant message, reasoning, tool call) in each family member's timeline. `updatedAt` is not used on its own: it also moves on title, label and mode changes and when a provider session reloads (for example `omp` emits `notification` and `todo` rows on load).
- Opening an agent to read it does not count as activity.
- After hibernating, the agent's workspace is archived too (so it leaves the sidebar) when nothing else uses it: no active agent, no terminal, not pinned. Archiving a Paseo-owned worktree deletes its directory (the branch stays), so those are archived only when `git status` is clean and HEAD is on a branch.
- **Tiếp tục** with the workspace still active sends the prompt; the agent reappears in that workspace. When the workspace was archived, the plugin API cannot restore it, so the plugin holds the prompt and opens the workspace in the app, whose recovery view offers **Unarchive** (or **Restore branch** when the worktree directory is gone). As soon as the workspace is active again, the plugin sends the held prompt and the agent continues in its original workspace.
- The chat history (last 400 conversation items) is captured before archiving and shown by **Lịch sử** in the dashboard. Reading an archived agent's timeline would load its session again; agents hibernated before capture existed are read once and archived again right away.

## UI

- Sidebar: **Agent ngủ đông**, the dashboard with **Tiếp tục**, **Lịch sử**, **Bỏ khỏi danh sách** and **Quét ngay**.
- Settings → Plugins → **Ngủ đông agent**: periodic scan switch and idle threshold in hours.
- Command Center (⌘K) on an agent: **Cho agent này ngủ đông** to archive it now.

The plugin's list of hibernated agents is stored in `$PASEO_HOME/plugin-data/agent-hibernate/hibernated.json` (default `~/.paseo`), captured histories next to it in `history/`.

## Install

Requires Paseo 0.9.2 or newer, on both the daemon and every app that should show the plugin, and **Settings → Plugins → Enable plugins** on the target daemon.

```bash
git clone https://github.com/hoangquocvietuet/paseo-agent-hibernate.git
paseo plugin install "$PWD/paseo-agent-hibernate"
```

Or let Paseo manage the checkout:

```bash
paseo plugin add hoangquocvietuet/paseo-agent-hibernate
```

Update a cloned install with `git pull && paseo plugin reload agent-hibernate`.

Plugins are trusted, unsandboxed code: the server part runs with the daemon user's access.

## Develop

```bash
npm install
npm run typecheck
paseo plugin reload agent-hibernate
paseo plugin logs agent-hibernate
```
