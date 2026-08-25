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
import type { LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { getAnnotation } from "@/utils/score";
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
    const classifiedNodesRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!active || !engine || !activeTab) return;
        const listenerId = liveCoachId(engine.id);

        const unlisten = events.bestMovesPayload.listen(({ payload }) => {
            if (
                payload.engine !== listenerId ||
                payload.tab !== activeTab ||
                payload.fen !== fen ||
                !equal(payload.moves, moves) ||
                payload.bestLines.length === 0
            ) {
                return;
            }

            bestLinesCacheRef.current.set(finalFen, payload.bestLines);
            setBestMoveUci(payload.bestLines[0].uciMoves[0] ?? null);

            if (liveEvalEnabled) {
                setScore(payload.bestLines[0].score);
            }

            if (payload.progress < 100) return;

            const state = store.getState();
            const mainLine = Array.from(treeIteratorMainLine(state.root));
            const tip = mainLine[mainLine.length - 1];
            if (tip.node.fen !== finalFen || !tip.node.move) return;

            const nodeKey = tip.position.join(",");
            if (classifiedNodesRef.current.has(nodeKey)) return;

            const color = tip.node.halfMoves % 2 === 1 ? "white" : "black";
            const colorFeedbackEnabled = color === "white" ? whiteFeedbackEnabled : blackFeedbackEnabled;
            if (!colorFeedbackEnabled) return;

            const parentEntry = mainLine[mainLine.length - 2];
            const grandparentEntry = mainLine.length >= 3 ? mainLine[mainLine.length - 3] : null;
            const prevMoves = bestLinesCacheRef.current.get(parentEntry.node.fen) ?? [];
            const prevScore = prevMoves[0]?.score.value ?? null;
            const prevprevScore = grandparentEntry
                ? (bestLinesCacheRef.current.get(grandparentEntry.node.fen)?.[0]?.score.value ?? null)
                : null;

            const annotation = getAnnotation(
                prevprevScore,
                prevScore,
                payload.bestLines[0].score.value,
                color,
                prevMoves,
                false,
                tip.node.san || "",
            );

            if (annotation) {
                setNodeAnnotation(tip.position, annotation);
                classifiedNodesRef.current.add(nodeKey);
            }
        });

        return () => {
            unlisten.then((f) => f());
        };
    }, [
        active,
        engine,
        activeTab,
        fen,
        JSON.stringify(moves),
        finalFen,
        liveEvalEnabled,
        whiteFeedbackEnabled,
        blackFeedbackEnabled,
        setScore,
        setNodeAnnotation,
        store,
    ]);

    useThrottledEffect(
        () => {
            if (!active || !engine || !activeTab) return;
            if (isGameOver) {
                commands.stopEngine(liveCoachId(engine.id), activeTab).then((r) => unwrap(r));
                return;
            }
            commands
                .getBestMoves(liveCoachId(engine.id), engine.path, activeTab, LIVE_COACH_GO_MODE, {
                    fen,
                    moves,
                    extraOptions: [{ name: "MultiPV", value: "2" }],
                })
                .then((r) => unwrap(r));
        },
        50,
        [active, engine, activeTab, fen, JSON.stringify(moves), isGameOver],
    );

    return { bestMoveUci, engine };
}

export default useLiveCoachEngine;
