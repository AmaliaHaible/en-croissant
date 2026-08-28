import { Button, Checkbox, Group, Modal, NumberInput, Select, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { memo, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { commands, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";
import { buildAnalysisLabel } from "@/utils/analysisLabel";
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";

const defaultReportSettings = {
  novelty: true,
  reversed: true,
  showBestMoves: true,
  bestMovesMode: "mistakes" as "mistakes" | "always",
  bestMovesCount: 1,
  bestMovesDepth: 10,
  goMode: { t: "Time", c: 500 } as Exclude<GoMode, { t: "Infinite" }>,
  engine: "",
};

const reportSettingsAtom = atomWithStorage("report-settings", defaultReportSettings);

function ReportModal({
  tab,
  initialFen,
  moves,
  reportingMode,
  closeReportingMode,
  setInProgress,
}: {
  tab: string;
  initialFen: string;
  moves: string[];
  reportingMode: boolean;
  closeReportingMode: () => void;
  setInProgress: (value: boolean) => void;
}) {
  const { t } = useTranslation();

  const referenceDb = useAtomValue(referenceDbAtom);
  const engines = useAtomValue(enginesAtom);
  const localEngines = useMemo(() => {
    const seen = new Set<string>();
    return (engines ?? [])
      .filter((e): e is LocalEngine => e.type === "local")
      .filter((e) => {
        if (!e || !e.id || seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
  }, [engines]);
  const store = useContext(TreeStateContext)!;
  const addAnalysis = useStore(store, (s) => s.addAnalysis);

  const [reportSettings, setReportSettings] = useAtom(reportSettingsAtom);

  const form = useForm({
    initialValues: { ...defaultReportSettings, ...reportSettings },
    validate: {
      engine: (value) => {
        if (!value) return t("Board.Analysis.EngineRequired");
      },
      novelty: (value) => {
        if (value && !referenceDb) return t("Board.Analysis.RefDBRequired");
      },
    },
  });

  useEffect(() => {
    const engine =
      localEngines.length === 0
        ? ""
        : !reportSettings.engine || !localEngines.some((l) => l.id === reportSettings.engine)
          ? localEngines[0].id
          : reportSettings.engine;

    form.setValues({ ...defaultReportSettings, ...reportSettings, engine });
  }, [localEngines, reportSettings]);

  function analyze() {
    setReportSettings(form.values);
    setInProgress(true);
    closeReportingMode();
    const engine = localEngines.find((e) => e.id === form.values.engine);
    const engineSettings = (engine ? getDefaultVariant(engine).settings : []).map((s) => ({
      ...s,
      value: s.value?.toString() ?? "",
    }));

    commands
      .analyzeGame(
        `report_${tab}`,
        engine?.path ?? "",
        form.values.goMode,
        {
          annotateNovelties: form.values.novelty,
          fen: initialFen,
          referenceDb,
          reversed: form.values.reversed,
          moves,
          bestMovesCount: form.values.showBestMoves ? form.values.bestMovesCount : 0,
        },
        engineSettings,
      )
      .then((analysis) => {
        if (analysis.status === "ok") {
          addAnalysis(analysis.data, {
            showBestMoves: form.values.showBestMoves,
            bestMovesMode: form.values.bestMovesMode,
            bestMovesCount: form.values.bestMovesCount,
            bestMovesDepth: form.values.bestMovesDepth,
            analysisLabel: engine ? buildAnalysisLabel(engine.name, form.values.goMode) : undefined,
          });
        }
      })
      .finally(() => setInProgress(false));
  }

  return (
    <Modal
      opened={reportingMode}
      onClose={closeReportingMode}
      title={t("Board.Analysis.GenerateReport")}
    >
      <form onSubmit={form.onSubmit(() => analyze())}>
        <Stack>
          <Select
            allowDeselect={false}
            withAsterisk
            label={t("Common.Engine")}
            placeholder="Pick one"
            data={
              localEngines.map((engine) => {
                return {
                  value: engine.id,
                  label: engine.name,
                };
              }) ?? []
            }
            {...form.getInputProps("engine")}
          />
          <Group wrap="nowrap">
            <Select
              allowDeselect={false}
              comboboxProps={{
                position: "bottom",
                middlewares: { flip: false, shift: false },
              }}
              data={[
                { label: t("GoMode.Depth"), value: "Depth" },
                { label: t("Board.Analysis.Time"), value: "Time" },
                { label: t("GoMode.Nodes"), value: "Nodes" },
              ]}
              value={form.values.goMode.t}
              onChange={(v) => {
                const newGo = form.values.goMode;
                newGo.t = v as "Depth" | "Time" | "Nodes";
                form.setFieldValue("goMode", newGo);
              }}
            />
            <NumberInput
              min={1}
              value={form.values.goMode.c as number}
              onChange={(v) =>
                form.setFieldValue("goMode", {
                  ...(form.values.goMode as any),
                  c: (v || 1) as number,
                })
              }
            />
          </Group>

          <Checkbox
            label={t("Board.Analysis.Reversed")}
            description={t("Board.Analysis.Reversed.Desc")}
            {...form.getInputProps("reversed", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.AnnotateNovelties")}
            description={t("Board.Analysis.AnnotateNovelties.Desc")}
            {...form.getInputProps("novelty", { type: "checkbox" })}
          />

          <Checkbox
            label={t("Board.Analysis.ShowBestMoves")}
            description={t("Board.Analysis.ShowBestMoves.Desc")}
            {...form.getInputProps("showBestMoves", { type: "checkbox" })}
          />

          {form.values.showBestMoves && (
            <Stack gap="xs" pl="lg">
              <Select
                allowDeselect={false}
                label={t("Board.Analysis.BestMovesMode")}
                data={[
                  { value: "mistakes", label: t("Board.Analysis.BestMovesMode.Mistakes") },
                  { value: "always", label: t("Board.Analysis.BestMovesMode.Always") },
                ]}
                {...form.getInputProps("bestMovesMode")}
              />
              <NumberInput
                label={t("Board.Analysis.BestMovesCount")}
                description={t("Board.Analysis.BestMovesCount.Desc")}
                min={1}
                max={4}
                {...form.getInputProps("bestMovesCount")}
              />
              <NumberInput
                label={t("Board.Analysis.BestMovesDepth")}
                description={t("Board.Analysis.BestMovesDepth.Desc")}
                min={1}
                max={20}
                {...form.getInputProps("bestMovesDepth")}
              />
            </Stack>
          )}

          <Group justify="right">
            <Button type="submit">{t("Board.Analysis.Analyze")}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default memo(ReportModal);
