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
import { HistoryView } from "./history-view";

const DEFAULT_RESUME_PROMPT = "Continue";

type Theme = PluginSurfaceProps["theme"];
type RowNavigation = { openAgent(): void; openWorkspace(workspaceId: string): void } | null;

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
  const [viewing, setViewing] = useState<HibernatedAgentView | null>(null);

  const query = useQuery({ queryKey: listKey, queryFn: () => list({}), refetchInterval: 30_000 });
  const scanMutation = useMutation({
    mutationFn: () => scan({}),
    onSuccess: ({ hibernated }) => {
      toast.show(
        hibernated.length > 0 ? `Hibernated ${hibernated.length} agent(s)` : "No agent idle long enough",
        { variant: hibernated.length > 0 ? "success" : "info" },
      );
      return queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (error) => toast.error(String(error)),
  });

  if (viewing) {
    return (
      <HistoryView entry={viewing} theme={theme} compact={layout.compact} onBack={() => setViewing(null)} />
    );
  }

  const nowMs = query.dataUpdatedAt || Date.now();
  const data = query.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={{ gap: 4, flexShrink: 1 }}>
          <Text style={styles.title}>Hibernated agents</Text>
          {data ? (
            <Text style={styles.muted}>
              {data.enabled
                ? `Agents idle for more than ${data.idleHours} h are archived automatically.`
                : "Automatic scan is off."}{" "}
              {data.lastScanAt ? `Last scan ${formatAgo(data.lastScanAt, nowMs)}.` : ""}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" style={styles.button} onPress={openSettings}>
            <Text style={styles.buttonText}>Settings</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.primaryButton}
            disabled={scanMutation.isPending}
            onPress={() => scanMutation.mutate()}
          >
            <Text style={styles.primaryButtonText}>
              {scanMutation.isPending ? "Scanning..." : "Scan now"}
            </Text>
          </Pressable>
        </View>
      </View>

      {query.isError ? <Text style={styles.danger}>{String(query.error)}</Text> : null}
      {query.isPending ? <Text style={styles.muted}>Loading...</Text> : null}
      {data && data.entries.length === 0 ? (
        <Text style={styles.muted}>No hibernated agents.</Text>
      ) : null}
      {data?.entries.map((entry) => (
        <HibernatedRow
          key={entry.agentId}
          entry={entry}
          theme={theme}
          compact={layout.compact}
          nowMs={nowMs}
          listKey={listKey}
          onOpenHistory={() => setViewing(entry)}
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
  onOpenHistory,
  navigation,
}: {
  entry: HibernatedAgentView;
  theme: Theme;
  compact: boolean;
  nowMs: number;
  listKey: readonly unknown[];
  onOpenHistory(): void;
  navigation: RowNavigation;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const queryClient = useQueryClient();
  const toast = useToast();
  const resume = useRpc(resumeRpc);
  const cancelResume = useRpc(cancelResumeRpc);
  const forget = useRpc(forgetRpc);
  const [prompt, setPrompt] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });

  const resumeMutation = useMutation({
    mutationFn: (text: string) => resume({ agentId: entry.agentId, prompt: text }),
    onSuccess: (result) => {
      setPrompt(null);
      if (result.status === "resumed") {
        navigation?.openAgent();
      } else {
        toast.show(
          `Could not reopen the workspace (${result.error}). Press Unarchive or Restore; the agent continues there.`,
          { variant: "info", durationMs: 10000 },
        );
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

  const workspaceLabel = entry.workspaceName ?? entry.workspaceId;

  return (
    <View style={styles.card}>
      <Text style={styles.rowTitle} numberOfLines={2}>
        {entry.title ?? "Untitled agent"}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {entry.cwd}
      </Text>
      <Text style={styles.muted}>
        {entry.model ? `${entry.provider} · ${entry.model}` : entry.provider}
      </Text>
      <Text style={styles.muted}>
        Last active {formatAgo(entry.lastActivityAt, nowMs)} · hibernated{" "}
        {formatAgo(entry.hibernatedAt, nowMs)}
        {entry.reason === "manual" ? " (manually)" : ""}
      </Text>
      {workspaceLabel ? (
        <Text style={styles.muted} numberOfLines={1}>
          Workspace: {workspaceLabel}
          {entry.workspaceActive ? "" : " (closed)"}
        </Text>
      ) : null}
      {entry.subagentCount > 0 ? (
        <Text style={styles.muted}>
          With {entry.subagentCount} sub-agent(s). They reopen when the main agent prompts them.
        </Text>
      ) : null}

      {entry.pendingPrompt !== null ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          <Text style={styles.warning}>
            Could not reopen the workspace automatically. Press Unarchive or Restore on the
            workspace screen and the agent receives “{entry.pendingPrompt}”.
          </Text>
          <View style={styles.actions}>
            {navigation && entry.workspaceId ? (
              <Pressable
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={() => navigation.openWorkspace(entry.workspaceId!)}
              >
                <Text style={styles.primaryButtonText}>Open workspace</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              disabled={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            >
              <Text style={styles.buttonText}>Stop waiting</Text>
            </Pressable>
          </View>
        </View>
      ) : prompt !== null ? (
        <View style={{ gap: 8, marginTop: 4 }}>
          {!entry.workspaceActive ? (
            <Text style={styles.muted}>
              The workspace is archived; it reopens when you send.
            </Text>
          ) : null}
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Message for the agent"
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
                {resumeMutation.isPending ? "Waking up..." : "Send and open"}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setPrompt(null)}>
              <Text style={styles.buttonText}>Cancel</Text>
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
            <Text style={styles.primaryButtonText}>Continue</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.button} onPress={onOpenHistory}>
            <Text style={styles.buttonText}>View chat</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            disabled={forgetMutation.isPending}
            onPress={() => forgetMutation.mutate()}
          >
            <Text style={styles.buttonText}>Remove from list</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
