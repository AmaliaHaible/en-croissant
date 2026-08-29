import { commands } from "@/bindings";
import type { ReportSettings } from "@/state/atoms";
import type { TreeStoreState } from "@/state/store/tree";
import { buildAnalysisLabel } from "@/utils/analysisLabel";
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";

export function generateReport({
  tab,
  initialFen,
  moves,
  referenceDb,
  engine,
  settings,
  addAnalysis,
  setInProgress,
}: {
  tab: string;
  initialFen: string;
  moves: string[];
  referenceDb: string | null;
  engine: LocalEngine | undefined;
  settings: ReportSettings;
  addAnalysis: TreeStoreState["addAnalysis"];
  setInProgress: (value: boolean) => void;
}) {
  setInProgress(true);
  const engineSettings = (engine ? getDefaultVariant(engine).settings : []).map((s) => ({
    ...s,
    value: s.value?.toString() ?? "",
  }));

  return commands
    .analyzeGame(
      `report_${tab}`,
      engine?.path ?? "",
      settings.goMode,
      {
        annotateNovelties: settings.novelty,
        fen: initialFen,
        referenceDb,
        reversed: settings.reversed,
        moves,
        bestMovesCount: settings.showBestMoves ? settings.bestMovesCount : 0,
      },
      engineSettings,
    )
    .then((analysis) => {
      if (analysis.status === "ok") {
        addAnalysis(analysis.data, {
          showBestMoves: settings.showBestMoves,
          bestMovesMode: settings.bestMovesMode,
          bestMovesCount: settings.bestMovesCount,
          bestMovesDepth: settings.bestMovesDepth,
          analysisLabel: engine ? buildAnalysisLabel(engine.name, settings.goMode) : undefined,
        });
      }
    })
    .finally(() => setInProgress(false));
}
