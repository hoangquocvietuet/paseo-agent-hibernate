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

  const recordActivity = (agentId: string, { paseo }: PluginHookContext) => {
    hibernator.attach(paseo);
    hibernator.touch(agentId);
  };
  // Opening an agent (including to read its history) loads it without bumping `updatedAt`.
  // Count the open as activity so a freshly viewed agent is not archived under the reader.
  server.before("agent.session_open", ({ request }, context) => {
    recordActivity(request.agentId, context);
  });
  server.on("agent.created", (event, context) => recordActivity(event.agent.id, context));
  server.on("agent.turn_started", (event, context) => recordActivity(event.agent.id, context));
  server.on("agent.turn_ended", (event, context) => recordActivity(event.agent.id, context));

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
