import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { historyRpc, type HibernatedAgentView } from "../shared/rpc";
import { Markdown } from "./markdown";

type Theme = PluginSurfaceProps["theme"];

/** Read-only chat of a hibernated agent, from the copy captured before it was archived. */
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
  const query = useQuery({
    queryKey: ["agent-hibernate", "history", entry.agentId],
    queryFn: () => history({ agentId: entry.agentId }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: 16, maxWidth: 900, width: "100%" as const, alignSelf: "center" as const },
      header: { gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      back: { alignSelf: "flex-start" as const, paddingVertical: 4, marginBottom: 4 },
      backText: { color: theme.colors.accent },
      title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" style={styles.back} onPress={onBack}>
          <Text style={styles.backText}>← Hibernated agents</Text>
        </Pressable>
        <Text style={styles.title}>{entry.title ?? "Untitled agent"}</Text>
        <Text style={styles.muted} numberOfLines={1}>
          {entry.cwd}
        </Text>
        <Text style={styles.muted}>
          {entry.model ? `${entry.provider} · ${entry.model}` : entry.provider}
        </Text>
        {query.data ? (
          <Text style={styles.muted}>
            {query.data.truncated ? `Latest ${query.data.items.length} messages. ` : ""}
            Saved {new Date(query.data.capturedAt).toLocaleString()}.
          </Text>
        ) : null}
      </View>

      {query.isPending ? <Text style={styles.muted}>Loading history...</Text> : null}
      {query.isError ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {query.data?.items.length === 0 ? <Text style={styles.muted}>No messages.</Text> : null}
      {query.data?.items.map((item, index) =>
        item.kind === "user" ? (
          <View key={index} style={styles.userBubble}>
            <Text selectable style={styles.userText}>
              {item.text}
            </Text>
            <Text style={[styles.time, { marginTop: 6 }]}>{new Date(item.timestamp).toLocaleString()}</Text>
          </View>
        ) : (
          <View key={index} style={styles.assistant}>
            <Markdown source={item.text} theme={theme} />
            <Text style={styles.time}>{new Date(item.timestamp).toLocaleString()}</Text>
          </View>
        ),
      )}
    </ScrollView>
  );
}
