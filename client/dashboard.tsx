import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  cancelResumeRpc,
  forgetRpc,
  listRpc,
  resumeRpc,
  scanRpc,
  type HibernatedAgentView,
} from "../shared/rpc";
import { formatAgo } from "./format";
import { HistoryModal } from "./history-modal";

const DEFAULT_RESUME_PROMPT = "Tiếp tục";

type Theme = PluginSurfaceProps["theme"];

function createStyles(theme: Theme, compact: boolean) {
  const button = {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  };
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 16 : 24, gap: 12 },
    header: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      justifyContent: "space-between" as const,
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      gap: 12,
    },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted },
    warning: { color: theme.colors.statusWarning },
    danger: { color: theme.colors.statusDanger },
    card: {
      padding: 12,
      gap: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rowTitle: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
    button,
    buttonText: { color: theme.colors.foreground },
    primaryButton: { ...button, borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    primaryButtonText: { color: theme.colors.accentForeground },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      padding: 8,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
    },
  };
}

export function HibernateDashboard({ theme, layout, host, navigation, openSettings }: PluginSurfaceProps & {
  openSettings(): void;
}) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const toast = useToast();
  const listKey = ["agent-hibernate", "list", host.id];
  const list = useRpc(listRpc);
  const scan = useRpc(scanRpc);

  const query = useQuery({ queryKey: listKey, queryFn: () => list({}), refetchInterval: 30_000 });
  const scanMutation = useMutation({
    mutationFn: () => scan({}),
    onSuccess: ({ hibernated }) => {
      toast.show(
        hibernated.length > 0 ? `Đã cho ${hibernated.length} agent ngủ đông` : "Không có agent nào đủ lâu",
        { variant: hibernated.length > 0 ? "success" : "info" },
      );
      return queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (error) => toast.error(String(error)),
  });

  const nowMs = query.dataUpdatedAt || Date.now();
  const data = query.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={{ gap: 4, flexShrink: 1 }}>
          <Text style={styles.title}>Agent đang ngủ đông</Text>
          {data ? (
            <Text style={styles.muted}>
              {data.enabled
                ? `Tự archive agent idle quá ${data.idleHours} giờ.`
                : "Tự động quét đang tắt."}{" "}
              {data.lastScanAt ? `Quét lần cuối ${formatAgo(data.lastScanAt, nowMs)}.` : ""}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" style={styles.button} onPress={openSettings}>
            <Text style={styles.buttonText}>Cài đặt</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.primaryButton}
            disabled={scanMutation.isPending}
            onPress={() => scanMutation.mutate()}
          >
            <Text style={styles.primaryButtonText}>
              {scanMutation.isPending ? "Đang quét..." : "Quét ngay"}
            </Text>
          </Pressable>
        </View>
      </View>

      {query.isError ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {query.isPending ? <Text style={styles.muted}>Đang tải...</Text> : null}
      {data && data.entries.length === 0 ? (
        <Text style={styles.muted}>Chưa có agent nào đang ngủ đông.</Text>
      ) : null}
      {data?.entries.map((entry) => (
        <HibernatedRow
          key={entry.agentId}
          entry={entry}
          theme={theme}
          compact={layout.compact}
          nowMs={nowMs}
          listKey={listKey}
          navigation={
            navigation
              ? {
                  openAgent: () => navigation.openAgent({ agentId: entry.agentId, serverId: host.id }),
                  openWorkspace: (workspaceId: string) =>
                    navigation.openWorkspace({ workspaceId, serverId: host.id }),
                }
              : null
          }
        />
      ))}
    </ScrollView>
  );
}

function HibernatedRow({
  entry,
  theme,
  compact,
  nowMs,
  listKey,
  navigation,
}: {
  entry: HibernatedAgentView;
  theme: Theme;
  compact: boolean;
  nowMs: number;
  listKey: readonly unknown[];
  navigation: { openAgent(): void; openWorkspace(workspaceId: string): void } | null;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const toast = useToast();
  const resume = useRpc(resumeRpc);
  const cancelResume = useRpc(cancelResumeRpc);
  const forget = useRpc(forgetRpc);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });

  const resumeMutation = useMutation({
    mutationFn: (text: string) => resume({ agentId: entry.agentId, prompt: text }),
    onSuccess: (result) => {
      setPrompt(null);
      if (result.status === "resumed") {
        navigation?.openAgent();
      } else {
        toast.show("Bấm Unarchive/Restore để mở lại workspace; agent sẽ tự tiếp tục trong đó.", {
          variant: "info",
          durationMs: 8000,
        });
        navigation?.openWorkspace(result.workspaceId);
      }
      return invalidate();
    },
    onError: (error) => toast.error(String(error)),
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelResume({ agentId: entry.agentId }),
    onSuccess: invalidate,
    onError: (error) => toast.error(String(error)),
  });
  const forgetMutation = useMutation({
    mutationFn: () => forget({ agentId: entry.agentId }),
    onSuccess: invalidate,
    onError: (error) => toast.error(String(error)),
  });

  const title = entry.title ?? "Agent chưa đặt tên";
  const workspaceLabel = entry.workspaceName ?? entry.workspaceId;

  return (
    <View style={styles.card}>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {entry.cwd}
      </Text>
      <Text style={styles.muted}>
        {entry.model ? `${entry.provider} · ${entry.model}` : entry.provider}
      </Text>
      <Text style={styles.muted}>
        Hoạt động cuối {formatAgo(entry.lastActivityAt, nowMs)} · ngủ đông{" "}
        {formatAgo(entry.hibernatedAt, nowMs)}
        {entry.reason === "manual" ? " (thủ công)" : ""}
      </Text>
      {workspaceLabel ? (
        <Text style={styles.muted} numberOfLines={1}>
          Workspace: {workspaceLabel}
          {entry.workspaceActive ? "" : " (đã đóng)"}
        </Text>
      ) : null}
      {entry.subagentCount > 0 ? (
        <Text style={styles.muted}>
          Kèm {entry.subagentCount} sub-agent. Chúng mở lại khi main agent gửi prompt cho chúng.
        </Text>
      ) : null}

      {entry.pendingPrompt !== null ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          <Text style={styles.warning}>
            Đang chờ mở lại workspace. Bấm Unarchive/Restore ở màn workspace, agent sẽ tự nhận lời
            nhắn “{entry.pendingPrompt}”.
          </Text>
          <View style={styles.actions}>
            {navigation && entry.workspaceId ? (
              <Pressable
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={() => navigation.openWorkspace(entry.workspaceId!)}
              >
                <Text style={styles.primaryButtonText}>Mở workspace</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              disabled={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            >
              <Text style={styles.buttonText}>Hủy chờ</Text>
            </Pressable>
          </View>
        </View>
      ) : prompt !== null ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          {!entry.workspaceActive ? (
            <Text style={styles.muted}>
              Workspace đã đóng: sau khi gửi, bấm Unarchive/Restore để mở lại nó.
            </Text>
          ) : null}
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Lời nhắn gửi cho agent"
            multiline
            autoFocus
          />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={styles.primaryButton}
              disabled={resumeMutation.isPending || prompt.trim().length === 0}
              onPress={() => resumeMutation.mutate(prompt)}
            >
              <Text style={styles.primaryButtonText}>
                {resumeMutation.isPending ? "Đang đánh thức..." : "Gửi và mở"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setPrompt(null)}>
              <Text style={styles.buttonText}>Hủy</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={() => setPrompt(DEFAULT_RESUME_PROMPT)}
          >
            <Text style={styles.primaryButtonText}>Tiếp tục</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => setHistoryOpen(true)}>
            <Text style={styles.buttonText}>Lịch sử</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            disabled={forgetMutation.isPending}
            onPress={() => forgetMutation.mutate()}
          >
            <Text style={styles.buttonText}>Bỏ khỏi danh sách</Text>
          </Pressable>
        </View>
      )}
      {historyOpen ? (
        <HistoryModal
          agentId={entry.agentId}
          title={title}
          theme={theme}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
        />
      ) : null}
    </View>
  );
}
