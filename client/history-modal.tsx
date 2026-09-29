import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { historyRpc, type HistoryItem } from "../shared/rpc";

type Theme = PluginSurfaceProps["theme"];

const KIND_LABELS: Record<HistoryItem["kind"], string> = {
  user: "Bạn",
  assistant: "Agent",
  reasoning: "Suy nghĩ",
  tool: "Công cụ",
  error: "Lỗi",
};

export function HistoryModal({
  agentId,
  title,
  theme,
  open,
  onOpenChange,
}: {
  agentId: string;
  title: string;
  theme: Theme;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const history = useRpc(historyRpc);
  const query = useQuery({
    queryKey: ["agent-hibernate", "history", agentId],
    queryFn: () => history({ agentId }),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
      item: { gap: 2 },
      userItem: {
        gap: 2,
        padding: 8,
        borderRadius: 6,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      text: { color: theme.colors.foreground },
      quietText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme],
  );

  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        {query.isPending ? <Text style={styles.muted}>Đang tải lịch sử...</Text> : null}
        {query.isError ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
        {query.data ? (
          <Text style={styles.muted}>
            {query.data.truncated ? `${query.data.items.length} mục gần nhất. ` : ""}
            Lưu lúc {new Date(query.data.capturedAt).toLocaleString()}.
          </Text>
        ) : null}
        {query.data?.items.length === 0 ? (
          <Text style={styles.muted}>Không có nội dung trò chuyện.</Text>
        ) : null}
        {query.data?.items.map((item, index) => {
          const quiet = item.kind === "tool" || item.kind === "reasoning";
          return (
            <View key={index} style={item.kind === "user" ? styles.userItem : styles.item}>
              <Text style={styles.label}>
                {KIND_LABELS[item.kind]} · {new Date(item.timestamp).toLocaleString()}
              </Text>
              <Text
                selectable
                style={item.kind === "error" ? styles.danger : quiet ? styles.quietText : styles.text}
              >
                {item.text}
              </Text>
            </View>
          );
        })}
      </Modal.Content>
    </Modal>
  );
}
