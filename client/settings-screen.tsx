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
    return <Text style={{ color: theme.colors.foregroundMuted }}>Đang tải...</Text>;
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
  const hoursError = Number.isFinite(hours) && hours > 0 ? null : "Nhập số giờ lớn hơn 0";

  return (
    <SettingsSection title="Ngủ đông agent">
      <SettingsCard>
        <SettingsSwitch
          label="Tự động quét"
          hint="Mỗi 10 phút, archive các agent idle quá ngưỡng. Nút Quét ngay vẫn chạy khi tắt."
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) =>
            void settings.save({ ...settings.values, enabled }, settings.revision)
          }
        />
        <SettingsInput
          label="Ngưỡng idle (giờ)"
          hint="Agent không có hoạt động lâu hơn ngưỡng này sẽ bị archive."
          initialValue={hoursDraft}
          onChangeText={setHoursDraft}
          error={hoursError}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Lưu ngưỡng"
          actionLabel={settings.saving ? "Đang lưu..." : "Lưu"}
          disabled={settings.saving || hoursError !== null || hours === settings.values.idleHours}
          error={settings.saveError}
          onPress={() => void settings.save({ ...settings.values, idleHours: hours }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
