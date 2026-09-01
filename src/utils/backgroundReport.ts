import type { NormalizedGame } from "@/bindings";
import { commands } from "@/bindings";
import { type ReportSettings, withReportSettingsDefaults } from "@/state/atoms";
import { backgroundReportKey, setBackgroundReportRunning } from "@/state/backgroundReports";
import { createTreeStore } from "@/state/store/tree";
import { getMainLine, getPGN, parsePGN } from "@/utils/chess";
import type { LocalEngine } from "@/utils/engines";
import { generateReport } from "@/utils/report";
import { resolveAnalysisLabel } from "@/utils/tabs";

/**
 * Run a full analysis report for a database game without opening it in a tab.
 *
 * Reuses the exact report pipeline (`generateReport` -> `analyzeGame` ->
 * `addAnalysis`) against a throwaway tree store, then persists the annotated
 * game the same way `saveToFile` does for database-origin tabs: write the PGN
 * back and stamp the analysis-marker label so the game shows as analyzed and
 * the auto-report feature leaves it alone.
 */
export async function runBackgroundReport({
    databasePath,
    game,
    referenceDb,
    engine,
    settings,
}: {
    databasePath: string;
    game: NormalizedGame;
    referenceDb: string | null;
    engine: LocalEngine;
    settings: ReportSettings;
}): Promise<void> {
    const key = backgroundReportKey(databasePath, game.id);
    setBackgroundReportRunning(key, true);
    try {
        const resolved = withReportSettingsDefaults(settings);
        const tree = await parsePGN(game.moves, game.fen || undefined);
        tree.headers = { ...tree.headers, ...game };
        const store = createTreeStore(undefined, tree);

        const applied = await generateReport({
            tab: `bg_${key}`,
            initialFen: store.getState().root.fen,
            moves: getMainLine(store.getState().root),
            referenceDb,
            engine,
            settings: resolved,
            addAnalysis: store.getState().addAnalysis,
            setInProgress: () => {},
            trackTabMount: false,
        });
        if (!applied) {
            throw new Error("Analysis did not complete");
        }

        const pgn = `${getPGN(store.getState().root, {
            headers: store.getState().headers,
            comments: true,
            extraMarkups: true,
            glyphs: true,
            variations: true,
        })}\n\n`;

        await commands.writeDbGame(databasePath, game.id, pgn);
        await commands.setGameAnalysisLabel(
            databasePath,
            game.id,
            resolveAnalysisLabel(store.getState().headers),
        );
    } finally {
        setBackgroundReportRunning(key, false);
    }
}
