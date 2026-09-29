# paseo-agent-hibernate

A [Paseo](https://paseo.sh) plugin that frees agents idle for too long and lets you resume them from one dashboard.

Every 10 minutes the plugin archives main agents whose whole family (the agent and its sub-agents) has been idle for longer than the threshold (12 hours by default). Archiving closes the provider session and drops the retained timeline, so the memory goes back to the host. Archived agents stay listed in the plugin's dashboard, and **Tiếp tục** sends them a prompt, which makes the daemon unarchive and resume them.

## Behavior

- Only agents with a live session (`idle` or `error`) are considered. The daemon stores agents as `closed` on shutdown and loads them lazily, so unloaded agents are left alone.
- Sub-agents (agents carrying the `paseo.parent-agent-id` label) are never archived by the plugin. When the plugin archives a main agent, the daemon archives its sub-agents too (or detaches those with an open tab or in another workspace). A sub-agent reopens when its main agent prompts it.
- A family is skipped while any member is running, has an active turn, or waits for a permission.
- The most recent activity of any family member counts: turns, and opening an agent (including to read its history).
- For the first `idleHours` after the plugin starts, the periodic scan does nothing, because activity from before the start is unknown. **Quét ngay** in the dashboard is not affected.

## UI

- Sidebar: **Agent ngủ đông**, the dashboard with **Tiếp tục**, **Xem**, **Bỏ khỏi danh sách** and **Quét ngay**.
- Settings → Plugins → **Ngủ đông agent**: periodic scan switch and idle threshold in hours.
- Command Center (⌘K) on an agent: **Cho agent này ngủ đông** to archive it now.

The plugin's list of hibernated agents is stored in `$PASEO_HOME/plugin-data/agent-hibernate/hibernated.json` (default `~/.paseo`).

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
