import { Stack, Text } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import EngineSettingsForm from "@/components/panels/analysis/EngineSettingsForm";
import {
  type CoachEngineConfig,
  enginesAtom,
  hintEngineConfigAtom,
  liveEvalEngineConfigAtom,
} from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";

function CoachEngineSection({
  configAtom,
  title,
  description,
}: {
  configAtom: typeof liveEvalEngineConfigAtom | typeof hintEngineConfigAtom;
  title: string;
  description: string;
}) {
  const [config, setConfig] = useAtom(configAtom);
  const allEngines = useAtomValue(enginesAtom);
  const localEngines = (allEngines ?? []).filter((e): e is LocalEngine => e.type === "local");
  const selectedEngine = localEngines.find((e) => e.id === config.engineId) ?? null;

  const setEngine = (engine: LocalEngine | null) => {
    setConfig((prev: CoachEngineConfig) => ({
      ...prev,
      engineId: engine?.id ?? null,
      settings: engine?.settings ?? [],
    }));
  };

  return (
    <Stack gap="xs">
      <Text fw={500}>{title}</Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <EnginesSelect engine={selectedEngine} setEngine={setEngine} />
      {selectedEngine && (
        <EngineSettingsForm
          engine={selectedEngine}
          remote={false}
          settings={{
            go: config.go,
            settings: config.settings,
            enabled: true,
            synced: false,
          }}
          setSettings={(fn) =>
            setConfig((prev) => {
              const next = fn({
                go: prev.go,
                settings: prev.settings,
                enabled: true,
                synced: false,
              });
              return { ...prev, go: next.go, settings: next.settings };
            })
          }
        />
      )}
    </Stack>
  );
}

export default function CoachSettingsTab() {
  const { t } = useTranslation();

  return (
    <Stack>
      <CoachEngineSection
        configAtom={liveEvalEngineConfigAtom}
        title={t("Settings.Coach.LiveEval")}
        description={t("Settings.Coach.LiveEval.Desc")}
      />
      <CoachEngineSection
        configAtom={hintEngineConfigAtom}
        title={t("Settings.Coach.Hint")}
        description={t("Settings.Coach.Hint.Desc")}
      />
    </Stack>
  );
}
