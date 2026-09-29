import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { HibernateDashboard } from "./client/dashboard";
import { HibernateSettingsScreen } from "./client/settings-screen";
import { hibernateAgentRpc } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings("hibernate");
  const Dashboard = (props: PluginSurfaceProps) => (
    <HibernateDashboard {...props} openSettings={openSettings} />
  );

  client.addSurface("hibernate", Dashboard);
  client.addSidebarItem({
    id: "hibernate",
    title: "Agent ngủ đông",
    icon: "Moon",
    surface: "hibernate",
  });
  client.addSettingsScreen({
    id: "hibernate",
    title: "Ngủ đông agent",
    icon: "Moon",
    Component: HibernateSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-hibernated",
    title: "Mở danh sách agent ngủ đông",
    icon: "Moon",
    keywords: ["hibernate", "sleep", "archive", "idle"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("hibernate");
    },
  });
  client.addCommandCenterItem({
    id: "hibernate-agent",
    title: "Cho agent này ngủ đông",
    icon: "Moon",
    keywords: ["hibernate", "sleep", "archive", "free memory"],
    context: "agent",
    async onSelect({ agent, rpc, openSurface }) {
      await rpc(hibernateAgentRpc, { agentId: agent.id });
      openSurface("hibernate");
    },
  });
  return () => {};
}
