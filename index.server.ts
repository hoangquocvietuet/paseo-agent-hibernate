import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Hibernator } from "./server/hibernator";
import { defaultRegistryPath, HibernationRegistry } from "./server/registry";
import {
  cancelResumeRpc,
  forgetRpc,
  hibernateAgentRpc,
  historyRpc,
  listRpc,
  resumeRpc,
  scanRpc,
} from "./shared/rpc";
import { hibernateSettings } from "./shared/settings";

const SCAN_INTERVAL_MS = 10 * 60 * 1000;
/** How quickly a held prompt follows the user restoring its workspace in the app. */
const PENDING_RESUME_INTERVAL_MS = 3 * 1000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(hibernateSettings);
  const registry = new HibernationRegistry(defaultRegistryPath());
  const hibernator = new Hibernator(settings, registry);

  // Hooks only hand the periodic scan an API handle; activity comes from agent timelines.
  const attach = (_event: unknown, { paseo }: PluginHookContext) => hibernator.attach(paseo);
  server.on("agent.created", attach);
  server.on("agent.turn_started", attach);
  server.on("agent.turn_ended", attach);

  server.handle(listRpc, (_input, { paseo }) => hibernator.list(paseo));
  server.handle(scanRpc, async (_input, { paseo }) => ({
    hibernated: await hibernator.scan(paseo),
  }));
  server.handle(hibernateAgentRpc, ({ agentId }, { paseo }) =>
    hibernator.hibernateAgent(paseo, agentId),
  );
  server.handle(resumeRpc, ({ agentId, prompt }, { paseo }) =>
    hibernator.resume(paseo, agentId, prompt),
  );
  server.handle(cancelResumeRpc, async ({ agentId }) => {
    await hibernator.cancelResume(agentId);
    return {};
  });
  server.handle(forgetRpc, async ({ agentId }) => {
    await registry.remove([agentId]);
    return {};
  });
  server.handle(historyRpc, async ({ agentId, before, limit }, { paseo }) => {
    const history = await hibernator.history(paseo, agentId);
    const end = Math.min(before ?? history.items.length, history.items.length);
    const start = Math.max(0, end - limit);
    return { ...history, start, items: history.items.slice(start, end) };
  });

  const scanTimer = setInterval(() => {
    hibernator.scanIfEnabled().catch((error) => console.error("Hibernate scan failed", error));
  }, SCAN_INTERVAL_MS);
  const pendingTimer = setInterval(() => {
    hibernator.resumePending().catch((error) => console.error("Pending resume failed", error));
  }, PENDING_RESUME_INTERVAL_MS);
  return () => {
    clearInterval(scanTimer);
    clearInterval(pendingTimer);
  };
}
