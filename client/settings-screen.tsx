import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { hibernateSettings } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof hibernateSettings.schema>, { status: "ready" }>;

export function HibernateSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(hibernateSettings);
  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading...</Text>;
  }
  if (settings.status !== "ready") {
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  }
  // Remount on external saves so the hours draft starts from the stored value.
  return <HibernateControls key={settings.revision} settings={settings} />;
}

function HibernateControls({ settings }: { settings: ReadySettings }) {
  const [hoursDraft, setHoursDraft] = useState(String(settings.values.idleHours));
  const hours = Number(hoursDraft.replace(",", "."));
  const hoursError = Number.isFinite(hours) && hours > 0 ? null : "Enter a number of hours above 0";

  return (
    <SettingsSection title="Agent hibernation">
      <SettingsCard>
        <SettingsSwitch
          label="Automatic scan"
          hint="Every 10 minutes, archive agents idle past the threshold. Scan now still works when this is off."
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) =>
            void settings.save({ ...settings.values, enabled }, settings.revision)
          }
        />
        <SettingsInput
          label="Idle threshold (hours)"
          hint="Agents with no conversation activity for longer than this are archived."
          initialValue={hoursDraft}
          onChangeText={setHoursDraft}
          error={hoursError}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Save threshold"
          actionLabel={settings.saving ? "Saving..." : "Save"}
          disabled={settings.saving || hoursError !== null || hours === settings.values.idleHours}
          error={settings.saveError}
          onPress={() => void settings.save({ ...settings.values, idleHours: hours }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
