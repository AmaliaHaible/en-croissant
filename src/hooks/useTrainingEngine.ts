import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
    activeTabAtom,
    enginesAtom,
    trainingEvalEngineConfigAtom,
    trainingEvalMovetimeAtom,
    trainingStateAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { withMultiPvFloor } from "@/utils/coach";
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { unwrap } from "@/utils/unwrap";

const TRAINING_EVAL_SUFFIX = "-training-eval";

function trainingEvalId(engineId: string): string {
    return `${engineId}${TRAINING_EVAL_SUFFIX}`;
}

/**
 * Continuous evaluation of the active training tab's current position. Writes
 * `score` onto whichever tree node the board sits on and exposes the latest
 * MultiPV lines for the panel.
 *
 * Deliberately mirrors `useLiveCoachEngine` / `useCoachHint`'s lifecycle
 * plumbing (event listener + throttled search effect + synchronous
 * short-circuit consumption + unmount cleanup) rather than sharing an
 * abstraction: that shape already went through a full review cycle that caught
 * real concurrency/lifecycle bugs, so duplicating it here is lower risk than
 * factoring out a shared helper.
 */
export function useTrainingEngine(): {
    engine: LocalEngine | null;
    lines: BestMoves[];
    resultFen: string;
} {
    const trainingState = useAtomValue(trainingStateAtom);
    const active =
        trainingState.phase === "waiting" ||
        trainingState.phase === "checking" ||
        trainingState.phase === "opponentThinking";
    const config = useAtomValue(trainingEvalEngineConfigAtom);
    const movetime = useAtomValue(trainingEvalMovetimeAtom);

    const engines = useAtomValue(enginesAtom);
    const engine = useMemo(() => {
        const loadedLocal = (engines ?? []).filter(
            (e): e is LocalEngine => e.type === "local" && !!e.loaded,
        );
        return loadedLocal.find((e) => e.id === config.engineId) ?? loadedLocal[0] ?? null;
    }, [engines, config.engineId]);

    const variant = useMemo(
        () =>
            engine
                ? (engine.variants.find((v) => v.id === config.variantId) ??
                  getDefaultVariant(engine))
                : null,
        [engine, config.variantId],
    );

    const goMode: GoMode = useMemo(() => ({ t: "Time", c: Math.max(50, movetime) }), [movetime]);
    // Merge the MultiPV floor into whatever is configured rather than only using
    // it when nothing is configured: any UI write of the engine's own UCI
    // defaults would otherwise silently pin MultiPV to 1. See `withMultiPvFloor`.
    // 10 lines: the training panel shows a fixed 2×5 grid of candidate moves.
    const extraOptions = useMemo(() => withMultiPvFloor(variant?.settings ?? [], 10), [variant]);

    const activeTab = useAtomValue(activeTabAtom);
    const store = useContext(TreeStateContext)!;
    const setScore = useStore(store, (s) => s.setScore);
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

    const [lines, setLines] = useState<BestMoves[]>([]);
    const [resultFen, setResultFen] = useState("");

    // The engine process we last asked to search, so it can still be stopped or
    // killed after `engine`/`activeTab` changed or became null.
    const startedRef = useRef<{ id: string; tab: string } | null>(null);
    const searchingRef = useRef(false);

    // When training stops, drop whatever we published for the previous position.
    useEffect(() => {
        if (!active) {
            setLines([]);
            setResultFen("");
        }
    }, [active]);

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
            // The eval bar can follow the search as it deepens.
            setScore(bestLines[0].score);
            // But `lines` / `resultFen` drive a binary keep-or-undo decision (the
            // prior-score capture in `waiting`, the threshold test in `checking`),
            // so they must only ever see a *completed* search. Intermediate lines
            // are shallow and noisy, and the "good enough" threshold in an opening
            // is only a few centipawns wide, so a mid-search eval flips the verdict
            // on moves the finished search rates as fine — the move is undone and
            // the real eval only shows up a split second later. `useLiveCoachEngine`
            // / `useCoachHint` (which this hook mirrors) gate their decision output
            // the same way. The go-mode here is always `{ t: "Time" }`, which
            // reports progress===100 on completion.
            if (progress < 100) return;
            setLines(bestLines);
            setResultFen(finalFen);
        };
    });

    useEffect(() => {
        if (!active || !engine || !activeTab) return;
        const listenerId = trainingEvalId(engine.id);

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
            const id = trainingEvalId(engine.id);

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

    // Leaving the training tab unmounts this hook: tear the process down entirely.
    useEffect(() => {
        return () => {
            const started = startedRef.current;
            if (!started) return;
            startedRef.current = null;
            searchingRef.current = false;
            commands.killEngine(started.id, started.tab).catch(() => {});
        };
    }, []);

    return { engine, lines, resultFen };
}

export default useTrainingEngine;
