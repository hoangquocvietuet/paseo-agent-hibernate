import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { historyRpc, type HibernatedAgentView, type HistoryItem } from "../shared/rpc";
import { Markdown } from "./markdown";

type Theme = PluginSurfaceProps["theme"];

const PAGE_SIZE = 30;

/**
 * Read-only chat of a hibernated agent, from the copy captured before it was archived. Opens at
 * the newest message; scrolling up loads earlier pages.
 */
export function HistoryView({
  entry,
  theme,
  compact,
  onBack,
}: {
  entry: HibernatedAgentView;
  theme: Theme;
  compact: boolean;
  onBack(): void;
}) {
  const history = useRpc(historyRpc);
  const query = useInfiniteQuery({
    queryKey: ["agent-hibernate", "history", entry.agentId],
    queryFn: ({ pageParam }) => history({ agentId: entry.agentId, before: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => (page.start > 0 ? page.start : undefined),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        gap: 4,
        paddingHorizontal: compact ? 16 : 24,
        paddingTop: compact ? 12 : 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      back: { alignSelf: "flex-start" as const, paddingVertical: 4 },
      backText: { color: theme.colors.accent },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 22, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger, padding: 16 },
      list: { flex: 1 },
      listContent: {
        padding: compact ? 16 : 24,
        gap: 16,
        maxWidth: 900,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      edge: { color: theme.colors.foregroundMuted, textAlign: "center" as const, paddingVertical: 8 },
      userBubble: {
        alignSelf: "flex-end" as const,
        maxWidth: "85%" as const,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface2,
      },
      userText: { color: theme.colors.foreground, fontSize: 15, lineHeight: 22 },
      assistant: { gap: 4 },
      time: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, compact],
  );

  // Newest first: the list is inverted, so index 0 sits at the bottom.
  const messages = useMemo(
    () =>
      (query.data?.pages ?? []).flatMap((page) =>
        page.items.map((item, offset) => ({ key: page.start + offset, item })).reverse(),
      ),
    [query.data],
  );
  const firstPage = query.data?.pages[0];

  let topEdge: string | null = null;
  if (query.isFetchingNextPage) topEdge = "Loading earlier messages...";
  else if (firstPage && !query.hasNextPage && messages.length > 0) {
    topEdge = firstPage.truncated ? "Earlier messages were not saved." : "Start of the conversation.";
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" style={styles.back} onPress={onBack}>
          <Text style={styles.backText}>← Hibernated agents</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={2}>
          {entry.title ?? "Untitled agent"}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {entry.model ? `${entry.provider} · ${entry.model}` : entry.provider} · {entry.cwd}
        </Text>
      </View>

      {query.isPending ? <Text style={[styles.muted, { padding: 16 }]}>Loading chat...</Text> : null}
      {query.isError ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {firstPage && messages.length === 0 ? (
        <Text style={[styles.muted, { padding: 16 }]}>No messages.</Text>
      ) : null}
      {messages.length > 0 ? (
        <FlatList
          inverted
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={messages}
          keyExtractor={(message) => String(message.key)}
          renderItem={({ item: message }) => (
            <ChatMessage item={message.item} theme={theme} styles={styles} />
          )}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          initialNumToRender={10}
          ListFooterComponent={topEdge ? <Text style={styles.edge}>{topEdge}</Text> : null}
        />
      ) : null}
    </View>
  );
}

function ChatMessage({
  item,
  theme,
  styles,
}: {
  item: HistoryItem;
  theme: Theme;
  styles: {
    userBubble: object;
    userText: object;
    assistant: object;
    time: object;
  };
}) {
  const time = new Date(item.timestamp).toLocaleString();
  if (item.kind === "user") {
    return (
      <View style={styles.userBubble}>
        <Text selectable style={styles.userText}>
          {item.text}
        </Text>
        <Text style={[styles.time, { marginTop: 6 }]}>{time}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      <Markdown source={item.text} theme={theme} />
      <Text style={styles.time}>{time}</Text>
    </View>
  );
}
