import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type BestMoves, commands, events } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
    activeTabAtom,
    coachFeedbackBlackAtom,
    coachFeedbackWhiteAtom,
    enginesAtom,
    liveEvalEnabledAtom,
    liveEvalEngineConfigAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { classifyMove, withMultiPvFloor } from "@/utils/coach";
import type { LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { treeIteratorMainLine } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const LIVE_COACH_SUFFIX = "-live-coach";

function liveCoachId(engineId: string): string {
    return `${engineId}${LIVE_COACH_SUFFIX}`;
}

export function useLiveCoachEngine(): {
    engine: LocalEngine | null;
} {
    const liveEvalEnabled = useAtomValue(liveEvalEnabledAtom);
    const whiteFeedbackEnabled = useAtomValue(coachFeedbackWhiteAtom);
    const blackFeedbackEnabled = useAtomValue(coachFeedbackBlackAtom);
    const active = liveEvalEnabled || whiteFeedbackEnabled || blackFeedbackEnabled;

    const config = useAtomValue(liveEvalEngineConfigAtom);

    const engines = useAtomValue(enginesAtom);
    const engine = useMemo(() => {
        const loadedLocal = (engines ?? []).filter(
            (e): e is LocalEngine => e.type === "local" && !!e.loaded,
        );
        return loadedLocal.find((e) => e.id === config.engineId) ?? loadedLocal[0] ?? null;
    }, [engines, config.engineId]);

    const goMode = config.go;
    // Merge the MultiPV floor into whatever is configured rather than only using
    // it when nothing is configured: any UI write of the engine's own UCI
    // defaults (MultiPV 1 for a stock Stockfish) would otherwise silently and
    // permanently disable "Good" move detection. See `withMultiPvFloor`.
    const extraOptions = useMemo(() => withMultiPvFloor(config.settings), [config.settings]);

    const activeTab = useAtomValue(activeTabAtom);
    const store = useContext(TreeStateContext)!;
    const setScore = useStore(store, (s) => s.setScore);
    const setNodeAnnotation = useStore(store, (s) => s.setNodeAnnotation);
    const fen = useStore(store, (s) => s.root.fen);
    const moves = useStore(
        store,
        useShallow((s) => getVariationLine(s.root, s.position)),
    );

    const [pos] = positionFromFen(fen);
    if (pos) {
        for (const uci of moves) {
            const move = parseUci(uci);
            if (!move) break;
            pos.play(move);
        }
    }
    const isGameOver = pos?.isEnd() ?? false;
    const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : fen), [pos, fen]);

    const bestLinesCacheRef = useRef<Map<string, BestMoves[]>>(new Map());
    // Keyed by the fen of the classified node (not by its tree path): paths are
    // reused across a new game or a take-back, fens identify the actual position.
    const classifiedFensRef = useRef<Set<string>>(new Set());
    // The engine process we last asked to search, so it can still be stopped or
    // killed after `engine`/`activeTab` changed or became null.
    const startedRef = useRef<{ id: string; tab: string } | null>(null);
    const searchingRef = useRef(false);
    const mainLineLengthRef = useRef(0);

    // Shared handling of engine output, used both by the event listener and by
    // `get_best_moves`' synchronous short-circuit return value. Kept in a ref that
    // is refreshed after every render so neither effect needs it as a dependency.
    const handleResultRef = useRef<
        (resultFen: string, bestLines: BestMoves[], progress: number) => void
    >(() => {});
    useEffect(() => {
        handleResultRef.current = (resultFen, bestLines, progress) => {
            // Late answer for a position we already left.
            if (bestLines.length === 0 || resultFen !== finalFen) return;

            bestLinesCacheRef.current.set(finalFen, bestLines);

            if (liveEvalEnabled) {
                setScore(bestLines[0].score);
            }

            // GoMode::Infinite and GoMode::PlayersTime never report progress===100
            // from the backend (it caps at 99.99 until an explicit `stop()`, whose
            // final message usually arrives after the listener has already moved on
            // to a new position and gets discarded above) — so treat those go-modes
            // as always complete enough to classify here. `classifiedFens` already
            // dedupes, so this doesn't reclassify the same fen on every intermediate
            // line a long-running search keeps emitting. Do not revert this to a
            // plain `progress < 100` check: that silently disables all move
            // classification whenever live-eval is configured to Infinite/PlayersTime.
            if (progress < 100 && goMode.t !== "Infinite" && goMode.t !== "PlayersTime") return;

            const mainLine = Array.from(treeIteratorMainLine(store.getState().root));
            // The main line only gets shorter when the tree was rebuilt: a new game
            // in a match series, a take-back or a position edit. Those replay fens
            // that are still marked as classified, so drop the markers. (The engine
            // lines cache stays: analysis of a given fen is position-only and
            // remains valid.)
            if (mainLine.length < mainLineLengthRef.current) {
                classifiedFensRef.current.clear();
            }
            mainLineLengthRef.current = mainLine.length;

            const classification = classifyMove({
                mainLine,
                finalFen,
                bestLines,
                cache: bestLinesCacheRef.current,
                feedbackEnabled: {
                    white: whiteFeedbackEnabled,
                    black: blackFeedbackEnabled,
                },
                classifiedFens: classifiedFensRef.current,
            });

            if (classification) {
                setNodeAnnotation(classification.path, classification.annotation);
                classifiedFensRef.current.add(classification.fen);
            }
        };
    });

    useEffect(() => {
        if (!active || !engine || !activeTab) return;
        const listenerId = liveCoachId(engine.id);

        const unlisten = events.bestMovesPayload.listen(({ payload }) => {
            if (
                payload.engine !== listenerId ||
                payload.tab !== activeTab ||
                payload.fen !== fen ||
                !equal(payload.moves, moves)
            ) {
                return;
            }

            handleResultRef.current(finalFen, payload.bestLines, payload.progress);
        });

        return () => {
            unlisten.then((f) => f());
        };
    }, [active, engine, activeTab, fen, JSON.stringify(moves), finalFen]);

    useThrottledEffect(
        () => {
            if (!engine || !activeTab) return;
            const id = liveCoachId(engine.id);

            if (!active || isGameOver) {
                if (searchingRef.current) {
                    searchingRef.current = false;
                    // Stop the process that's actually running, not `id`: if the
                    // configured engine changed since the search was started, `id`
                    // (recomputed from the current `engine`) no longer matches it.
                    const started = startedRef.current;
                    if (started) {
                        commands.stopEngine(started.id, started.tab).then((r) => unwrap(r));
                    }
                }
                return;
            }

            const requestFen = finalFen;
            // The engine (or tab) resolved to something new since the last search
            // was started: that old process is no longer referenced by anything
            // below, so it would otherwise be orphaned. Kill it before moving on.
            const prevStarted = startedRef.current;
            if (prevStarted && (prevStarted.id !== id || prevStarted.tab !== activeTab)) {
                commands.killEngine(prevStarted.id, prevStarted.tab).catch(() => {});
            }
            searchingRef.current = true;
            startedRef.current = { id, tab: activeTab };
            commands
                .getBestMoves(id, engine.path, activeTab, goMode, {
                    fen,
                    moves,
                    extraOptions,
                })
                .then((r) => {
                    // A matching search is already running: the backend answers
                    // directly and emits no event, so consume the result here.
                    const result = unwrap(r);
                    if (!result) return;
                    const [progress, bestLines] = result;
                    handleResultRef.current(requestFen, bestLines, progress);
                });
        },
        50,
        [
            active,
            engine,
            activeTab,
            fen,
            JSON.stringify(moves),
            finalFen,
            isGameOver,
            goMode,
            extraOptions,
        ],
    );

    // Leaving the play tab unmounts this hook: tear the process down entirely.
    useEffect(() => {
        return () => {
            const started = startedRef.current;
            if (!started) return;
            startedRef.current = null;
            searchingRef.current = false;
            commands.killEngine(started.id, started.tab).catch(() => {});
        };
    }, []);

    return { engine };
}

export default useLiveCoachEngine;
