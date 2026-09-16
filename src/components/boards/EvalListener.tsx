import { parseUci } from "chessops";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import { startTransition, useContext, useEffect, useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type EngineOptions, events, type GoMode } from "@/bindings";
import {
  activeTabAtom,
  currentThreatAtom,
  engineMovesFamily,
  engineProgressFamily,
  enginesAtom,
  firstEngineWithLinesFamily,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getBestMoves as chessdbGetBestMoves } from "@/utils/chessdb/api";
import { positionFromFen, swapMove } from "@/utils/chessops";
import {
  type Engine,
  type LocalEngine,
  getBestMoves as localGetBestMoves,
  getDefaultVariant,
  killEngine,
  stopEngine,
} from "@/utils/engines";
import { getBestMoves as lichessGetBestMoves } from "@/utils/lichess/api";
import { useThrottledEffect } from "@/utils/misc";
import { TreeStateContext } from "../common/TreeStateContext";

function EvalListener() {
  const [engines] = useAtom(enginesAtom);
  const threat = useAtomValue(currentThreatAtom);
  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.root.fen);

  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );

  const [pos, error] = positionFromFen(fen);
  if (pos) {
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) {
        console.log("Invalid move", uci);
        break;
      }
      pos.play(move);
    }
  }

  const isGameOver = pos?.isEnd() ?? false;
  const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : null), [pos]);

  const { searchingFen, searchingMoves } = useMemo(
    () =>
      match(threat as boolean)
        .with(true, () => ({
          searchingFen: swapMove(finalFen || INITIAL_FEN),
          searchingMoves: [],
        }))
        .with(false, () => ({
          searchingFen: fen,
          searchingMoves: moves,
        }))
        .exhaustive(),
    [fen, moves, threat, finalFen],
  );

  const firstEngineWithLines = useAtomValue(
    firstEngineWithLinesFamily({
      fen: searchingFen,
      gameMoves: searchingMoves,
    }),
  );

  return (engines ?? [])
    .filter((e) => e.loaded)
    .map((e) => (
      <EngineListener
        key={e.id}
        engine={e}
        firstEngineWithLines={firstEngineWithLines}
        isGameOver={isGameOver}
        finalFen={finalFen || ""}
        searchingFen={searchingFen}
        searchingMoves={searchingMoves}
        fen={fen}
        moves={moves}
        threat={threat}
      />
    ));
}

function EngineListener({
  engine,
  firstEngineWithLines,
  isGameOver,
  finalFen,
  searchingFen,
  searchingMoves,
  fen,
  moves,
  threat,
}: {
  engine: Engine;
  firstEngineWithLines: string | null;
  isGameOver: boolean;
  finalFen: string;
  searchingFen: string;
  searchingMoves: string[];
  fen: string;
  moves: string[];
  threat: boolean;
}) {
  const store = useContext(TreeStateContext)!;
  const setScore = useStore(store, (s) => s.setScore);
  const activeTab = useAtomValue(activeTabAtom);

  const [, setProgress] = useAtom(engineProgressFamily({ engine: engine.id, tab: activeTab! }));

  const [, setEngineVariation] = useAtom(engineMovesFamily({ engine: engine.id, tab: activeTab! }));
  const defaultVariant = getDefaultVariant(engine);
  const [settings] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: defaultVariant.settings,
      defaultGo: defaultVariant.go,
      tab: activeTab!,
    }),
  );

  // Kept current every render so a resolving `getBestMoves` promise (below) can
  // tell whether the position it was asked about is still the one the user is
  // looking at, mirroring the `resultFen === rootFen` check in useEvalPreview.
  const searchingFenRef = useRef(searchingFen);
  const searchingMovesRef = useRef(searchingMoves);
  useEffect(() => {
    searchingFenRef.current = searchingFen;
    searchingMovesRef.current = searchingMoves;
  });

  // This listener only exists while its tab is the active one, so switching to
  // another tab (without closing this one) unmounts it. Without this, a local
  // engine search started below keeps running in the backend forever, since
  // `useThrottledEffect`'s own cleanup only clears a pending timeout, not an
  // already-started search (see useCoachHint/useEvalPreview/useTrainingEngine
  // for the same pattern).
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    return () => {
      const e = engineRef.current;
      const tab = activeTabRef.current;
      if (e.type === "local" && tab) {
        killEngine(e, tab).catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!settings.enabled) return;
    const unlisten = events.bestMovesPayload.listen(({ payload }) => {
      const ev = payload.bestLines;
      if (
        payload.engine === engine.id &&
        payload.tab === activeTab &&
        payload.fen === searchingFen &&
        equal(payload.moves, searchingMoves) &&
        settings.enabled &&
        !isGameOver
      ) {
        startTransition(() => {
          setEngineVariation((prev) => {
            const newMap = new Map(prev);
            newMap.set(`${searchingFen}:${searchingMoves.join(",")}`, ev);
            if (threat) {
              newMap.delete(`${fen}:${moves.join(",")}`);
            } else if (finalFen) {
              newMap.delete(`${swapMove(finalFen)}:`);
            }
            return newMap;
          });
          setProgress(payload.progress);
          const shouldSetScore =
            firstEngineWithLines === engine.id || firstEngineWithLines === null;
          if (shouldSetScore) {
            setScore(ev[0].score);
          }
        });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [
    activeTab,
    setScore,
    settings.enabled,
    isGameOver,
    searchingFen,
    JSON.stringify(searchingMoves),
    engine.id,
    setEngineVariation,
    firstEngineWithLines,
  ]);

  const getBestMoves = useMemo(
    () =>
      match(engine.type)
        .with(
          "local",
          () => (fen: string, goMode: GoMode, options: EngineOptions) =>
            localGetBestMoves(engine as LocalEngine, fen, goMode, options),
        )
        .with("chessdb", () => chessdbGetBestMoves)
        .with("lichess", () => lichessGetBestMoves)
        .exhaustive(),
    [engine.type, engine],
  );

  useThrottledEffect(
    () => {
      if (settings.enabled) {
        if (isGameOver) {
          if (engine.type === "local") {
            stopEngine(engine, activeTab!);
          }
        } else {
          const options =
            settings.settings?.map((s) => ({
              name: s.name,
              value: s.value?.toString() || "",
            })) ?? [];
          const requestFen = searchingFen;
          const requestMoves = searchingMoves;
          getBestMoves(activeTab!, settings.go, {
            moves: requestMoves,
            fen: requestFen,
            extraOptions: options,
          })
            .then((moves) => {
              if (!moves) return;
              // A slower response for a position we've since navigated away
              // from: applying it now would overwrite the current eval with a
              // stale one. Compare against the latest values (kept fresh every
              // render via the refs above), not the ones this closure captured
              // when the request was made.
              if (
                requestFen !== searchingFenRef.current ||
                !equal(requestMoves, searchingMovesRef.current)
              ) {
                return;
              }
              const [progress, bestMoves] = moves;
              setEngineVariation((prev) => {
                const newMap = new Map(prev);
                newMap.set(`${requestFen}:${requestMoves.join(",")}`, bestMoves);
                return newMap;
              });
              setProgress(progress);
            })
            .catch((error) => {
              console.error("Failed to get best moves", error);
              if (
                requestFen === searchingFenRef.current &&
                equal(requestMoves, searchingMovesRef.current)
              ) {
                // Stop showing a perpetual "still calculating" spinner for a
                // request that's never going to resolve.
                setProgress(100);
              }
            });
        }
      } else {
        if (engine.type === "local") {
          stopEngine(engine, activeTab!);
        }
      }
    },
    50,
    [
      settings.enabled,
      JSON.stringify(settings.settings),
      settings.go,
      searchingFen,
      JSON.stringify(searchingMoves),
      isGameOver,
      activeTab,
      getBestMoves,
      setEngineVariation,
      engine,
    ],
  );
  return null;
}

export default EvalListener;
