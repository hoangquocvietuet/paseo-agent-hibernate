import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paseoHome } from "./registry";

const DEFAULT_PORT = 6767;
/** Recreating a worktree runs git; the app waits as long. */
const RESTORE_TIMEOUT_MS = 150_000;

const PersistedConfigSchema = z.object({
  daemon: z.object({ listen: z.string().optional() }).optional(),
});

const SessionFrameSchema = z.object({
  type: z.literal("session"),
  message: z.object({ type: z.string(), payload: z.unknown() }),
});

const ServerInfoSchema = z.object({ status: z.literal("server_info") });

const RestoreResponseSchema = z.object({
  requestId: z.string(),
  accepted: z.boolean(),
  error: z.string().nullable(),
});

/**
 * Restore an archived workspace with the daemon's recovery request, the one the app's Unarchive
 * and Restore branch buttons send: it unarchives that exact workspace and recreates a deleted
 * Paseo worktree from its branch. The plugin API has no equivalent, so this opens a short-lived
 * loopback session to the daemon. Unix-socket listeners are not supported.
 */
export async function restoreWorkspace(workspaceId: string): Promise<void> {
  const url = await daemonWebSocketUrl();
  const requestId = randomUUID();
  const socket = new WebSocket(url);
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out restoring the workspace")), RESTORE_TIMEOUT_MS);
      const settle = (error: Error | null) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.onopen = () =>
        send({ type: "hello", clientId: "agent-hibernate-recovery", clientType: "cli", protocolVersion: 1 });
      socket.onerror = () => settle(new Error(`Cannot reach the daemon at ${url}`));
      socket.onclose = (event) => settle(new Error(`The daemon closed the connection (${event.code})`));
      socket.onmessage = (event) => {
        const frame = SessionFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (!frame.success) return;
        const { type, payload } = frame.data.message;
        if (type === "status" && ServerInfoSchema.safeParse(payload).success) {
          send({
            type: "session",
            message: { type: "workspace.recovery.restore.request", workspaceId, requestId },
          });
        } else if (type === "workspace.recovery.restore.response") {
          const response = RestoreResponseSchema.parse(payload);
          if (response.requestId !== requestId) return;
          settle(response.accepted ? null : new Error(response.error ?? "The daemon rejected the restore"));
        }
      };
    });
  } finally {
    socket.onclose = null;
    socket.close();
  }
}

async function daemonWebSocketUrl(): Promise<string> {
  const raw = await readFile(join(paseoHome(), "config.json"), "utf8").catch(() => "{}");
  const listen =
    process.env.PASEO_LISTEN ??
    PersistedConfigSchema.parse(JSON.parse(raw)).daemon?.listen ??
    `127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;
  if (listen.startsWith("/") || listen.startsWith("unix:")) {
    throw new Error(`The daemon listens on a Unix socket (${listen})`);
  }
  const separator = listen.lastIndexOf(":");
  const host = listen.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = listen.slice(separator + 1);
  const loopback = host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `ws://${loopback.includes(":") ? `[${loopback}]` : loopback}:${port}/ws`;
}
