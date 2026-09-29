import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentHistory, HistoryItem } from "../shared/rpc";

type PaseoApi = PluginHandlerContext["paseo"];

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;
const MAX_ITEMS = 400;
const MAX_TEXT = 4000;
const MAX_REASONING = 1000;
/** Tool detail fields that summarize a call, in display priority. */
const TOOL_SUMMARY_FIELDS = ["command", "filePath", "query", "url", "description", "label", "text"];

/**
 * The newest conversation of an agent, compacted for reading back later. Loads the agent if it
 * is not loaded, so call it while the agent still holds its session.
 */
export async function captureHistory(api: PaseoApi, agentId: string): Promise<AgentHistory> {
  const timeline = api.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_LIMIT });
  if (page.error) throw new Error(page.error);
  let items = compact(page.entries);
  for (let pages = 1; page.hasOlder && page.startCursor && pages < MAX_PAGES; pages++) {
    if (items.length >= MAX_ITEMS) break;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_LIMIT });
    if (page.error) throw new Error(page.error);
    items = [...compact(page.entries), ...items];
  }
  return {
    capturedAt: new Date().toISOString(),
    truncated: page.hasOlder || items.length > MAX_ITEMS,
    items: items.slice(-MAX_ITEMS),
  };
}

function compact(entries: readonly { timestamp: string; item: object }[]): HistoryItem[] {
  return entries.flatMap((entry) => {
    const item = compactItem(entry.item);
    return item ? [{ timestamp: entry.timestamp, ...item }] : [];
  });
}

function compactItem(item: object): Omit<HistoryItem, "timestamp"> | null {
  const text = (key: string, limit = MAX_TEXT) => truncate(stringField(item, key) ?? "", limit);
  switch (stringField(item, "type")) {
    case "user_message":
      return { kind: "user", text: text("text") };
    case "assistant_message":
      return { kind: "assistant", text: text("text") };
    case "reasoning":
      return { kind: "reasoning", text: text("text", MAX_REASONING) };
    case "error":
      return { kind: "error", text: text("message") };
    case "tool_call": {
      const detail = Reflect.get(item, "detail");
      const summary =
        typeof detail === "object" && detail !== null
          ? TOOL_SUMMARY_FIELDS.map((key) => stringField(detail, key)).find(Boolean)
          : undefined;
      const failed = stringField(item, "status") === "failed" ? " (lỗi)" : "";
      const name = stringField(item, "name") ?? "tool";
      return { kind: "tool", text: truncate(summary ? `${name}: ${summary}${failed}` : `${name}${failed}`, 300) };
    }
    default:
      return null;
  }
}

function stringField(value: object, key: string): string | undefined {
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
