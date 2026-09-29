import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentHistory, HistoryItem } from "../shared/rpc";

type PaseoApi = PluginHandlerContext["paseo"];

const PAGE_LIMIT = 200;
/** Tool-heavy sessions interleave few chat items among many timeline rows. */
const MAX_PAGES = 20;
const MAX_ITEMS = 300;
const MAX_TEXT = 20_000;

/**
 * The newest chat (user and assistant messages) of an agent, for reading back later. Loads the
 * agent if it is not loaded, so call it while the agent still holds its session.
 */
export async function captureHistory(api: PaseoApi, agentId: string): Promise<AgentHistory> {
  const timeline = api.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_LIMIT });
  if (page.error) throw new Error(page.error);
  let items = chatItems(page.entries);
  for (let pages = 1; page.hasOlder && page.startCursor && pages < MAX_PAGES; pages++) {
    if (items.length >= MAX_ITEMS) break;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_LIMIT });
    if (page.error) throw new Error(page.error);
    items = [...chatItems(page.entries), ...items];
  }
  return {
    capturedAt: new Date().toISOString(),
    truncated: page.hasOlder || items.length > MAX_ITEMS,
    items: items.slice(-MAX_ITEMS),
  };
}

function chatItems(entries: readonly { timestamp: string; item: object }[]): HistoryItem[] {
  return entries.flatMap((entry) => {
    const type = Reflect.get(entry.item, "type");
    const text = Reflect.get(entry.item, "text");
    if (typeof text !== "string" || text.trim().length === 0) return [];
    const kind = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : null;
    if (!kind) return [];
    const bounded = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
    return [{ timestamp: entry.timestamp, kind, text: bounded }];
  });
}
