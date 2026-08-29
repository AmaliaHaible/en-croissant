import { Checkbox, Divider, Group, NumberInput, Select, Stack, Switch, Text } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import {
  autoGenerateReportAtom,
  type CoachEngineConfig,
  enginesAtom,
  hintEngineConfigAtom,
  liveEvalEngineConfigAtom,
  MAX_BEST_MOVES_COUNT,
  reportSettingsAtom,
  withReportSettingsDefaults,
} from "@/state/atoms";
import { type LocalEngine, resolveConfiguredEngine } from "@/utils/engines";

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
  // The dropdown only *offers* loaded engines — that's what
  // `useLiveCoachEngine`/`useCoachHint` can actually run. But the currently
  // configured engine is resolved against every local engine: an engine that's
  // merely unloaded right now is still the user's choice, and collapsing it to
  // `null` here would make `EnginesSelect` auto-select (and persist) a
  // different engine. See `resolveConfiguredEngine`.
  const loadedEngines = (allEngines ?? []).filter(
    (e): e is LocalEngine => e.type === "local" && !!e.loaded,
  );
  const selectedEngine = resolveConfiguredEngine(config.engineId, allEngines);
  const selectedEngineUnloaded = !!selectedEngine && !selectedEngine.loaded;

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
      {loadedEngines.length === 0 && !selectedEngine ? (
        <Text size="xs" c="dimmed">
          {t("Settings.Coach.NoEngines")}
        </Text>
      ) : (
        <EnginesSelect engine={selectedEngine} setEngine={setEngine} filter={(e) => !!e.loaded} />
      )}
      {selectedEngineUnloaded && (
        <Text size="xs" c="orange">
          {t("Settings.Coach.EngineNotLoaded")}
        </Text>
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

function ReportSection() {
  const { t } = useTranslation();
  const [autoGenerateReport, setAutoGenerateReport] = useAtom(autoGenerateReportAtom);
  const [reportSettings, setReportSettings] = useAtom(reportSettingsAtom);
  const settings = withReportSettingsDefaults(reportSettings);
  const allEngines = useAtomValue(enginesAtom);

  const localEngines = useMemo(() => {
    const seen = new Set<string>();
    return (allEngines ?? [])
      .filter((e): e is LocalEngine => e.type === "local")
      .filter((e) => {
        if (!e || !e.id || seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
  }, [allEngines]);

  const updateSettings = (partial: Partial<typeof settings>) => {
    setReportSettings(withReportSettingsDefaults({ ...settings, ...partial }));
  };

  return (
    <Stack gap="xs">
      <Divider my="xs" />
      <Text fw={500}>{t("Board.Analysis.Report")}</Text>
      <Switch
        label={t("Settings.Coach.AutoGenerateReport")}
        description={t("Settings.Coach.AutoGenerateReport.Desc")}
        checked={autoGenerateReport}
        onChange={(e) => setAutoGenerateReport(e.currentTarget.checked)}
      />

      <Select
        allowDeselect={false}
        label={t("Common.Engine")}
        placeholder="Pick one"
        data={localEngines.map((engine) => ({ value: engine.id, label: engine.name }))}
        value={settings.engine || null}
        onChange={(v) => v && updateSettings({ engine: v })}
      />

      <Group wrap="nowrap">
        <Select
          allowDeselect={false}
          data={[
            { label: t("GoMode.Depth"), value: "Depth" },
            { label: t("Board.Analysis.Time"), value: "Time" },
            { label: t("GoMode.Nodes"), value: "Nodes" },
          ]}
          value={settings.goMode.t}
          onChange={(v) => {
            if (!v) return;
            const newGo = settings.goMode;
            newGo.t = v as "Depth" | "Time" | "Nodes";
            updateSettings({ goMode: newGo });
          }}
        />
        <NumberInput
          min={1}
          value={settings.goMode.c as number}
          onChange={(v) =>
            updateSettings({ goMode: { ...(settings.goMode as any), c: (v || 1) as number } })
          }
        />
      </Group>

      <Checkbox
        label={t("Board.Analysis.Reversed")}
        description={t("Board.Analysis.Reversed.Desc")}
        checked={settings.reversed}
        onChange={(e) => updateSettings({ reversed: e.currentTarget.checked })}
      />

      <Checkbox
        label={t("Board.Analysis.AnnotateNovelties")}
        description={t("Board.Analysis.AnnotateNovelties.Desc")}
        checked={settings.novelty}
        onChange={(e) => updateSettings({ novelty: e.currentTarget.checked })}
      />

      <Checkbox
        label={t("Board.Analysis.ShowBestMoves")}
        description={t("Board.Analysis.ShowBestMoves.Desc")}
        checked={settings.showBestMoves}
        onChange={(e) => updateSettings({ showBestMoves: e.currentTarget.checked })}
      />

      {settings.showBestMoves && (
        <Stack gap="xs" pl="lg">
          <Select
            allowDeselect={false}
            label={t("Board.Analysis.BestMovesMode")}
            data={[
              { value: "mistakes", label: t("Board.Analysis.BestMovesMode.Mistakes") },
              { value: "always", label: t("Board.Analysis.BestMovesMode.Always") },
            ]}
            value={settings.bestMovesMode}
            onChange={(v) => v && updateSettings({ bestMovesMode: v as "mistakes" | "always" })}
          />
          <NumberInput
            label={t("Board.Analysis.BestMovesCount")}
            description={t("Board.Analysis.BestMovesCount.Desc")}
            min={1}
            max={MAX_BEST_MOVES_COUNT}
            value={settings.bestMovesCount}
            onChange={(v) => updateSettings({ bestMovesCount: (v || 1) as number })}
          />
          <NumberInput
            label={t("Board.Analysis.BestMovesDepth")}
            description={t("Board.Analysis.BestMovesDepth.Desc")}
            min={1}
            max={20}
            value={settings.bestMovesDepth}
            onChange={(v) => updateSettings({ bestMovesDepth: (v || 1) as number })}
          />
        </Stack>
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
      <ReportSection />
    </Stack>
  );
}
