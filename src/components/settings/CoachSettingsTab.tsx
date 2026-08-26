import { Stack, Text } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
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
  const { t } = useTranslation();
  const [config, setConfig] = useAtom(configAtom);
  const allEngines = useAtomValue(enginesAtom);
  // Must match what `useLiveCoachEngine`/`useCoachHint` accept: they only ever
  // use loaded local engines and silently fall back to the first loaded one
  // otherwise, so offering unloaded engines here would let the user "select" an
  // engine the coach never actually runs.
  const localEngines = (allEngines ?? []).filter(
    (e): e is LocalEngine => e.type === "local" && !!e.loaded,
  );
  const selectedEngine = localEngines.find((e) => e.id === config.engineId) ?? null;

  const setEngine = (engine: LocalEngine | null) => {
    setConfig((prev: CoachEngineConfig) => ({
      ...prev,
      engineId: engine?.id ?? null,
      variantId: engine?.variants[0]?.id ?? null,
    }));
  };

  const setVariantId = (variantId: string) => {
    setConfig((prev) => ({ ...prev, variantId }));
  };

  return (
    <Stack gap="xs">
      <Text fw={500}>{title}</Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      {localEngines.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t("Settings.Coach.NoEngines")}
        </Text>
      ) : (
        <EnginesSelect engine={selectedEngine} setEngine={setEngine} filter={(e) => !!e.loaded} />
      )}
      {selectedEngine && (
        <EngineVariantSelect
          engine={selectedEngine}
          variantId={config.variantId}
          setVariantId={setVariantId}
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
