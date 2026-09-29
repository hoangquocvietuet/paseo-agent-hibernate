import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { Hibernator } from "./server/hibernator";
import { defaultRegistryPath, HibernationRegistry } from "./server/registry";
import { forgetRpc, hibernateAgentRpc, listRpc, resumeRpc, scanRpc } from "./shared/rpc";
import { hibernateSettings } from "./shared/settings";

const SCAN_INTERVAL_MS = 10 * 60 * 1000;

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
  server.handle(resumeRpc, async ({ agentId, prompt }, { paseo }) => {
    await hibernator.resume(paseo, agentId, prompt);
    return { agentId };
  });
  server.handle(forgetRpc, async ({ agentId }) => {
    await registry.remove([agentId]);
    return {};
  });

  const timer = setInterval(() => {
    hibernator.scanIfEnabled().catch((error) => console.error("Hibernate scan failed", error));
  }, SCAN_INTERVAL_MS);
  return () => clearInterval(timer);
}
