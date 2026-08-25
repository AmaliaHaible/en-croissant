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
    coachFeedbackBlackAtom,
    coachFeedbackWhiteAtom,
    enginesAtom,
    liveEvalEnabledAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { classifyMove } from "@/utils/coach";
import type { LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { treeIteratorMainLine } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const LIVE_COACH_SUFFIX = "-live-coach";
const LIVE_COACH_GO_MODE: GoMode = { t: "Time", c: 300 };

function liveCoachId(engineId: string): string {
    return `${engineId}${LIVE_COACH_SUFFIX}`;
}

export function useLiveCoachEngine(hintActive: boolean): {
    bestMoveUci: string | null;
    engine: LocalEngine | null;
} {
    const liveEvalEnabled = useAtomValue(liveEvalEnabledAtom);
    const whiteFeedbackEnabled = useAtomValue(coachFeedbackWhiteAtom);
    const blackFeedbackEnabled = useAtomValue(coachFeedbackBlackAtom);
    const active = liveEvalEnabled || whiteFeedbackEnabled || blackFeedbackEnabled || hintActive;

    const engines = useAtomValue(enginesAtom);
    const engine = useMemo(
        () =>
            (engines ?? []).find(
                (e): e is LocalEngine => e.type === "local" && !!e.loaded,
            ) ?? null,
        [engines],
    );

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

    const [bestMoveUci, setBestMoveUci] = useState<string | null>(null);
    const bestLinesCacheRef = useRef<Map<string, BestMoves[]>>(new Map());
    // Keyed by the fen of the classified node (not by its tree path): paths are
    // reused across a new game or a take-back, fens identify the actual position.
    const classifiedFensRef = useRef<Set<string>>(new Set());
    // The engine process we last asked to search, so it can still be stopped or
    // killed after `engine`/`activeTab` changed or became null.
    const startedRef = useRef<{ id: string; tab: string } | null>(null);
    const searchingRef = useRef(false);
    const mainLineLengthRef = useRef(0);

    // The best move belongs to exactly one position: drop it as soon as the
    // position changes so a hint can never reveal a stale move.
    useEffect(() => {
        setBestMoveUci(null);
    }, [finalFen]);

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
            setBestMoveUci(bestLines[0].uciMoves[0] ?? null);

            if (liveEvalEnabled) {
                setScore(bestLines[0].score);
            }

            if (progress < 100) return;

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
                    commands.stopEngine(id, activeTab).then((r) => unwrap(r));
                }
                return;
            }

            const requestFen = finalFen;
            searchingRef.current = true;
            startedRef.current = { id, tab: activeTab };
            commands
                .getBestMoves(id, engine.path, activeTab, LIVE_COACH_GO_MODE, {
                    fen,
                    moves,
                    extraOptions: [{ name: "MultiPV", value: "2" }],
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
        [active, engine, activeTab, fen, JSON.stringify(moves), finalFen, isGameOver],
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

    return { bestMoveUci, engine };
}

export default useLiveCoachEngine;
