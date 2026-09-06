import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  Portal,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconArrowsExchange, IconCheck, IconInfoCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { makeUci, parseUci, type Position } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import { ImportantEngineSettings } from "@/components/common/ImportantEngineSettings";
import { useTrainingEngine } from "@/hooks/useTrainingEngine";
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
import {
  activeTabAtom,
  currentInvisibleAtom,
  enginesAtom,
  sessionsAtom,
  trainingBookSourceAtom,
  trainingColorAtom,
  trainingEvalEngineConfigAtom,
  trainingEvalMovetimeAtom,
  trainingHintAtom,
  trainingMaxLossPawnsAtom,
  trainingMaxLossPctAtom,
  trainingMinBookGamesAtom,
  trainingOpponentEngineConfigAtom,
  trainingSessionStatsAtom,
  trainingStateAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { withMultiPvFloor } from "@/utils/coach";
import { searchExplorerMoves } from "@/utils/db";
import { applySettingOverrides, type LocalEngine, resolveConfiguredEngine } from "@/utils/engines";
import {
  goodEnoughHints,
  passesThreshold,
  sampleBookMove,
  scoreToCp,
  type ThresholdConfig,
  totalBookGames,
} from "@/utils/training";
import { getNodeAtPath } from "@/utils/treeReducer";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";
import BoardControls from "./BoardControls";

const OPPONENT_DELAY_MS = 400;

const otherColor = (c: "white" | "black") => (c === "white" ? "black" : "white");
const fmtEval = (cp: number) => `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;

type Candidate = { san: string; uci: string; cp: number; goodEnough: boolean };

/** Turn the eval engine's MultiPV lines into a ranked candidate list, from the
 *  user's POV, flagging which ones clear the "good enough" threshold. */
function toCandidates(
  lines: BestMoves[],
  priorCp: number,
  userIsWhite: boolean,
  cfg: ThresholdConfig,
): Candidate[] {
  return lines
    .filter((l) => l.uciMoves[0])
    .map((l) => {
      const cp = scoreToCp(l.score, userIsWhite);
      return {
        san: l.sanMoves[0] ?? l.uciMoves[0],
        uci: l.uciMoves[0],
        cp,
        goodEnough: passesThreshold(priorCp, cp, cfg),
      };
    })
    .sort((a, b) => b.cp - a.cp);
}

function CandidateRow({ m, played }: { m: Candidate; played: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" w="100%">
      <Text fz="xs" fw={played ? 700 : 400}>
        {m.san}
        {played ? " ←" : ""}
      </Text>
      <Group gap={4} wrap="nowrap">
        <Text fz="xs" ff="monospace" c={m.goodEnough ? "teal" : "dimmed"}>
          {fmtEval(m.cp)}
        </Text>
        {m.goodEnough && <IconCheck size={12} color="var(--mantine-color-teal-6)" />}
      </Group>
    </Group>
  );
}

function CandidateList({
  moves,
  playedUci,
  onSelect,
}: {
  moves: Candidate[];
  playedUci?: string | null;
  onSelect?: (uci: string) => void;
}) {
  return (
    <Stack gap={onSelect ? 2 : 0}>
      {moves.map((m) => {
        const played = playedUci != null && m.uci === playedUci;
        return onSelect ? (
          <Button
            key={m.uci}
            variant="subtle"
            color="gray"
            size="compact-xs"
            fullWidth
            onClick={() => onSelect(m.uci)}
          >
            <CandidateRow m={m} played={played} />
          </Button>
        ) : (
          <Box key={m.uci} px={6} py={2}>
            <CandidateRow m={m} played={played} />
          </Box>
        );
      })}
    </Stack>
  );
}

function describeResult(pos: Position): string {
  const outcome = pos.outcome();
  if (!outcome) return "*";
  if (outcome.winner === "white") return "1-0";
  if (outcome.winner === "black") return "0-1";
  return "½-½";
}

function EngineConfigRow({ configAtom }: { configAtom: typeof trainingEvalEngineConfigAtom }) {
  const [config, setConfig] = useAtom(configAtom);
  const allEngines = useAtomValue(enginesAtom);
  const selected = resolveConfiguredEngine(config.engineId, allEngines);
  return (
    <Stack gap="xs">
      <EnginesSelect
        engine={selected}
        setEngine={(e: LocalEngine | null) =>
          setConfig({ engineId: e?.id ?? null, variantId: e?.variants[0]?.id ?? null })
        }
        filter={(e) => !!e.loaded}
      />
      {selected && (
        <EngineVariantSelect
          engine={selected}
          variantId={config.variantId}
          setVariantId={(variantId: string) => setConfig((p) => ({ ...p, variantId }))}
        />
      )}
    </Stack>
  );
}

/** Opponent-engine picker: engine + variant + the variant's "important" UCI
 *  options, exactly like the New Game opponent form. */
function OpponentConfigRow() {
  const [config, setConfig] = useAtom(trainingOpponentEngineConfigAtom);
  const allEngines = useAtomValue(enginesAtom);
  const selected = resolveConfiguredEngine(config.engineId, allEngines);
  return (
    <Stack gap="xs">
      <EnginesSelect
        engine={selected}
        setEngine={(e: LocalEngine | null) =>
          setConfig({
            engineId: e?.id ?? null,
            variantId: e?.variants[0]?.id ?? null,
            settingOverrides: [],
          })
        }
        filter={(e) => !!e.loaded}
      />
      {selected && (
        <EngineVariantSelect
          engine={selected}
          variantId={config.variantId}
          setVariantId={(variantId: string) =>
            setConfig((p) => ({ ...p, variantId, settingOverrides: [] }))
          }
        />
      )}
      {selected && (
        <ImportantEngineSettings
          engine={selected}
          variantId={config.variantId}
          overrides={config.settingOverrides ?? []}
          setOverrides={(next) => setConfig((p) => ({ ...p, settingOverrides: next }))}
        />
      )}
    </Stack>
  );
}

function BoardTraining() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, (s) => s.currentNode());
  const setFen = useStore(store, (s) => s.setFen);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const headers = useStore(store, (s) => s.headers);
  const storeMakeMove = useStore(store, (s) => s.makeMove);
  const goToMove = useStore(store, (s) => s.goToMove);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const position = useStore(store, (s) => s.position);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const { lines, resultFen } = useTrainingEngine(); // mounts the eval session for this tab

  const [state, setState] = useAtom(trainingStateAtom);
  const [color, setColor] = useAtom(trainingColorAtom);
  const [hint, setHint] = useAtom(trainingHintAtom);
  const [stats, setStats] = useAtom(trainingSessionStatsAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);
  const activeTab = useAtomValue(activeTabAtom);

  const [movetime, setMovetime] = useAtom(trainingEvalMovetimeAtom);
  const [source, setSource] = useAtom(trainingBookSourceAtom);
  const [minBookGames, setMinBookGames] = useAtom(trainingMinBookGamesAtom);
  const [maxLossPawns, setMaxLossPawns] = useAtom(trainingMaxLossPawnsAtom);
  const [maxLossPct, setMaxLossPct] = useAtom(trainingMaxLossPctAtom);
  const opponentConfig = useAtomValue(trainingOpponentEngineConfigAtom);

  const engines = useAtomValue(enginesAtom);
  const hasLoadedEngine = (engines ?? []).some((e) => e.type === "local" && e.loaded);
  const opponentEngine = resolveConfiguredEngine(opponentConfig.engineId, engines);
  const sessions = useAtomValue(sessionsAtom);
  const token = sessions.find((s) => s.lichess?.accessToken)?.lichess?.accessToken ?? null;

  const [fenInput, setFenInput] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);

  const inSetup = state.phase === "setup";

  const cfg = useMemo<ThresholdConfig>(
    () => ({ maxLossPawns, maxLossPct }),
    [maxLossPawns, maxLossPct],
  );
  const userIsWhite = color === "white";
  const startFenRef = useRef<string>(currentNode.fen);
  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;
  // The eval hook keys off `makeFen(pos.toSetup())` (fully normalized, 6 fields).
  // A pasted or derived 4-field FEN would never match at the root, so the prior
  // score is never captured and the session hangs on "Evaluating…". Canonicalise
  // at every entry point.
  const normalizeFen = (f: string): string => {
    const [p] = positionFromFen(f);
    return p ? makeFen(p.toSetup()) : f;
  };

  // Opponent engine id, kept fresh for the teardown paths (unmount / opponent
  // deactivation) which run outside render.
  const opponentEngineIdRef = useRef<string | null>(null);
  opponentEngineIdRef.current = opponentEngine?.id ?? null;
  const activeTabRef = useRef<string>("");
  activeTabRef.current = activeTab ?? "";

  const hintMoves = useMemo(() => {
    if (
      state.phase !== "waiting" ||
      state.priorScore === undefined ||
      resultFen !== currentNode.fen ||
      lines.length === 0
    ) {
      return [];
    }
    return goodEnoughHints(lines, state.priorScore, userIsWhite, cfg);
  }, [state.phase, state.priorScore, resultFen, currentNode.fen, lines, userIsWhite, cfg]);

  // The engine's candidate moves for the position it is your turn to move in —
  // fed to the "best moves currently" panel (revealed only once a hint is on).
  const currentCandidates = useMemo<Candidate[]>(() => {
    if (
      state.phase !== "waiting" ||
      state.priorScore === undefined ||
      resultFen !== currentNode.fen ||
      currentNode.fen !== state.fen ||
      lines.length === 0
    ) {
      return [];
    }
    return toCandidates(lines, state.priorScore, userIsWhite, cfg);
  }, [
    state.phase,
    state.priorScore,
    state.fen,
    resultFen,
    currentNode.fen,
    lines,
    userIsWhite,
    cfg,
  ]);

  // The candidate list + path for the position the current turn is being played
  // from, snapshotted while it is still your move so it survives into the next
  // turn as "best moves last turn".
  const lastWaitingRef = useRef<{
    path: number[];
    fen: string;
    prior: number;
    candidates: Candidate[];
  } | null>(null);
  useEffect(() => {
    if (currentCandidates.length > 0 && state.priorScore !== undefined) {
      lastWaitingRef.current = {
        path: state.path ?? [],
        fen: currentNode.fen,
        prior: state.priorScore,
        candidates: currentCandidates,
      };
    }
  }, [currentCandidates, state.path, state.priorScore, currentNode.fen]);

  function loadFen() {
    const parsed = parseFen(fenInput.trim());
    if (parsed.isErr) {
      setFenError(t("Board.Training.Setup.BadFen", "Not a valid FEN."));
      return;
    }
    setFenError(null);
    setFen(normalizeFen(fenInput.trim()));
    // The side to move in a training position is the opponent (they reply
    // first); you play the side that just moved.
    setColor(otherColor(parsed.unwrap().turn));
  }

  function startSession() {
    const startFen = normalizeFen(currentNode.fen);
    startFenRef.current = startFen;
    const [pos] = positionFromFen(startFen);
    // `color` already tracks "the side that just moved" (the setup effect keeps
    // it in sync) unless the user overrode it with "Swap sides" — honour
    // whatever it holds now. Normally the opponent is on move, so the session
    // opens in `opponentThinking`.
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: color });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setState({
      phase: pos?.turn === color ? "waiting" : "opponentThinking",
      fen: startFen,
      path: [],
      priorScore: undefined,
      checkParent: undefined,
      engineOpponentActive: false,
    });
  }

  function newGame() {
    const startFen = normalizeFen(startFenRef.current);
    const [pos] = positionFromFen(startFen);
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: color });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setState({
      phase: pos?.turn === color ? "waiting" : "opponentThinking",
      fen: startFen,
      path: [],
      priorScore: undefined,
      checkParent: undefined,
      engineOpponentActive: false,
    });
  }

  function stopSession() {
    goToMove([]);
    setState({ phase: "setup", engineOpponentActive: false });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(false);
  }

  function cycleHint() {
    setHint((h) => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }));
  }
  useHotkeys("h", cycleHint, { enabled: state.phase === "waiting" });

  // Jump back to the position last turn was played from and play `uci` there
  // instead — as a *variation*, keeping the line you actually played — then
  // continue with a fresh opponent reply. The "best moves last turn" list
  // stays put so you can keep trying alternatives from the same position.
  const redoLastTurn = useCallback(
    (uci: string) => {
      const lt = state.lastTurn;
      if (!lt) return;
      const move = parseUci(uci);
      if (!move) return;
      goToMove(lt.path);
      // `makeMove` (unlike `appendMove`) works off the pointer, so it branches
      // from `lt.path`: a new child if this move isn't there yet, else it just
      // navigates into the existing branch.
      storeMakeMove({ payload: move });
      const newPath = store.getState().position;
      const newNode = getNodeAtPath(store.getState().root, newPath);
      const [newPos] = positionFromFen(newNode.fen);
      setHint({ stage: 0 });
      setState((s) => ({
        ...s,
        lastTurn: s.lastTurn ? { ...s.lastTurn, playedUci: uci, rejected: false } : undefined,
        priorScore: undefined,
        checkParent: undefined,
        checkChild: undefined,
        ...(newPos?.isEnd()
          ? { phase: "gameOver" as const, result: describeResult(newPos) }
          : { phase: "opponentThinking" as const, fen: newNode.fen, path: newPath }),
      }));
    },
    [state.lastTurn, goToMove, storeMakeMove, store, setHint, setState],
  );

  // Reset the hint stage whenever the position changes (a move was played, or
  // the machine advanced — Stop / New Game change the FEN too).
  useEffect(() => {
    setHint({ stage: 0 });
  }, [currentNode.fen, setHint]);

  const pickEngineOpponentMove = useCallback(
    (path: number[]): Promise<string | null> => {
      if (!opponentEngine) return Promise.resolve(null);
      const variant =
        opponentEngine.variants.find((v) => v.id === opponentConfig.variantId) ??
        opponentEngine.variants[0];
      // The variant's saved settings with the user's per-session "important"
      // overrides applied (same set the New Game opponent form edits), then the
      // MultiPV floor merged in — a duplicate `MultiPV` entry desyncs the
      // backend's `real_multipv` and the search can yield nothing.
      const extraOptions = withMultiPvFloor(
        applySettingOverrides(variant?.settings ?? [], opponentConfig.settingOverrides ?? []),
        3,
      );
      // `getBestMoves` replays `moves` on top of `fen`, so the pair must be
      // root-fen + full-line-from-root (every other call site does this). Passing
      // the leaf fen here makes the first replayed move illegal → command error
      // → empty result. Read the root fresh in case the tree moved on.
      const freshRoot = store.getState().root;
      const moves = getVariationLine(freshRoot, path);
      const id = `${opponentEngine.id}-training-opponent`;
      const tab = activeTab ?? "";
      const go: GoMode = { t: "Time", c: 300 };
      const enginePath = opponentEngine.path;

      // Favour the top move but allow the 2nd/3rd sometimes.
      const pickFrom = (bestLines: { sanMoves: string[] }[]): string | null => {
        if (bestLines.length === 0) return null;
        const weights = [0.6, 0.3, 0.1];
        let r = Math.random();
        let idx = 0;
        for (let i = 0; i < Math.min(bestLines.length, 3); i++) {
          if (r < weights[i]) {
            idx = i;
            break;
          }
          r -= weights[i];
        }
        return bestLines[idx]?.sanMoves[0] ?? bestLines[0]?.sanMoves[0] ?? null;
      };

      // A fresh `-training-opponent` process never resolves its `getBestMoves`
      // future — the result arrives on `events.bestMovesPayload`. Mirror
      // `useCoachHint`'s shape: listen for the completed search, and also honour
      // the synchronous short-circuit return for an already-running match.
      return new Promise<string | null>((resolve) => {
        let settled = false;
        let unlisten: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (san: string | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (unlisten) unlisten();
          resolve(san);
        };

        events.bestMovesPayload
          .listen(({ payload }) => {
            if (
              payload.engine !== id ||
              payload.tab !== tab ||
              payload.fen !== freshRoot.fen ||
              !equal(payload.moves, moves)
            ) {
              return;
            }
            if (payload.progress >= 100) finish(pickFrom(payload.bestLines));
          })
          .then((f) => {
            unlisten = f;
            if (settled) f();
          });

        timer = setTimeout(() => finish(null), 5000);

        commands
          .getBestMoves(id, enginePath, tab, go, { fen: freshRoot.fen, moves, extraOptions })
          .then((res) => {
            const data = res.status === "ok" ? res.data : null;
            if (!data) return;
            const [progress, lines] = data;
            if (progress >= 100) finish(pickFrom(lines));
          })
          .catch(() => {});
      });
    },
    [opponentEngine, opponentConfig, activeTab, store],
  );

  // While still setting up: the last move played is yours, so you play the side
  // that is NOT to move, and the opponent replies first. The "Swap sides"
  // toggle writes `color` directly; the user then hits Start before the
  // position changes again, so their override sticks for that session.
  useEffect(() => {
    if (state.phase !== "setup") return;
    const [pos] = positionFromFen(currentNode.fen);
    if (pos) setColor(otherColor(pos.turn));
  }, [state.phase, currentNode.fen, setColor]);

  // Pin forward/back navigation to the played line.
  useEffect(() => {
    setPracticePath(state.phase !== "setup" ? (state.path ?? null) : null);
  }, [state.phase, state.path, setPracticePath]);

  // The move list is never blurred in training — the moves are generated live,
  // so there is nothing to "read ahead" to, and the candidate panels want it
  // legible.
  useEffect(() => {
    setInvisible(false);
  }, [setInvisible]);

  // waiting: capture the prior score once the engine answers for this position.
  useEffect(() => {
    if (state.phase !== "waiting" || state.priorScore !== undefined) return;
    if (resultFen !== currentNode.fen || lines.length === 0) return;
    // The user may have scrolled the board off the machine's position (arrow
    // keys / notation clicks aren't practicePath-aware). Don't capture a prior
    // from a node we aren't actually waiting on.
    if (currentNode.fen !== state.fen) return;
    setState((s) => ({ ...s, priorScore: scoreToCp(lines[0].score, userIsWhite) }));
  }, [
    state.phase,
    state.priorScore,
    state.fen,
    resultFen,
    lines,
    currentNode.fen,
    userIsWhite,
    setState,
  ]);

  // checking: evaluate the move the user just played.
  useEffect(() => {
    if (state.phase !== "checking") return;
    // The user can navigate away from the move under evaluation (arrow keys /
    // notation clicks aren't practicePath-aware). While off the child node, do
    // nothing — the effect resumes once the board returns to it.
    if (state.checkChild !== undefined && currentNode.fen !== state.checkChild) return;
    const childPath = position;
    const [childPos] = positionFromFen(currentNode.fen);

    // A move that ends the game (mate / stalemate delivered by the user) needs
    // no eval — and the eval engine won't run on a terminal position, so the
    // `lines` gate below would never open. Resolve it straight away.
    if (childPos?.isEnd()) {
      setStats((s) => ({ ...s, movesPlayed: s.movesPlayed + 1 }));
      setState((s) => ({ ...s, phase: "gameOver", result: describeResult(childPos) }));
      return;
    }

    if (resultFen !== currentNode.fen || lines.length === 0) return;
    const afterCp = scoreToCp(lines[0].score, userIsWhite);
    const prior = state.priorScore ?? 0;

    const snap = lastWaitingRef.current;
    const playedUci = currentNode.move ? makeUci(currentNode.move) : null;
    const lastTurn = (rejected: boolean) =>
      snap
        ? {
            path: snap.path,
            fen: snap.fen,
            prior: snap.prior,
            playedUci,
            rejected,
            candidates: snap.candidates,
          }
        : undefined;

    if (!passesThreshold(prior, afterCp, cfg)) {
      const parent = state.checkParent ?? [];
      deleteMove(childPath);
      goToMove(parent);
      setStats((s) => ({ ...s, mistakes: s.mistakes + 1 }));
      setState((s) => ({
        ...s,
        phase: "waiting",
        fen: getNodeAtPath(store.getState().root, parent).fen,
        path: parent,
        // priorScore for the parent is unchanged — keep it.
        lastTurn: lastTurn(true),
      }));
      return;
    }

    setStats((s) => ({ ...s, movesPlayed: s.movesPlayed + 1 }));
    setState((s) => ({
      ...s,
      phase: "opponentThinking",
      fen: currentNode.fen,
      path: childPath,
      priorScore: undefined,
      lastTurn: lastTurn(false),
    }));
  }, [
    state.phase,
    state.priorScore,
    state.checkParent,
    state.checkChild,
    resultFen,
    lines,
    currentNode.fen,
    currentNode.move,
    position,
    cfg,
    userIsWhite,
    store,
    deleteMove,
    goToMove,
    setStats,
    setState,
  ]);

  // opponentThinking: book sample, else out-of-book engine or stop.
  useEffect(() => {
    if (state.phase !== "opponentThinking") return;
    const fenAtStart = currentNode.fen;
    // The pointer wandered off the position the machine expects — don't think
    // from here. It resumes once the user navigates back (practicePath keeps
    // forward nav pinned to the live position).
    if (state.fen !== undefined && fenAtStart !== state.fen) return;
    const pathAtStart = position;
    const [posAtStart] = positionFromFen(fenAtStart);
    if (!posAtStart) return;
    if (posAtStart.isEnd()) {
      setState((s) => ({ ...s, phase: "gameOver", result: describeResult(posAtStart) }));
      return;
    }
    let cancelled = false;

    (async () => {
      let san: string | null = null;

      if (!state.engineOpponentActive) {
        const explorerStats = await searchExplorerMoves(source, [fenAtStart], token)
          .then((r) => r[0] ?? [])
          .catch(() => []);
        if (cancelled || currentFenRef.current !== fenAtStart) return;
        if (explorerStats.length === 0 || totalBookGames(explorerStats) < minBookGames) {
          setState((s) => ({ ...s, phase: "outOfBook" }));
          return;
        }
        san = sampleBookMove(explorerStats);
      } else {
        san = await pickEngineOpponentMove(pathAtStart);
        if (cancelled || currentFenRef.current !== fenAtStart) return;
      }

      if (!san) {
        setState((s) => ({ ...s, phase: "outOfBook" }));
        return;
      }
      const move = parseSan(posAtStart, san);
      if (!move) {
        setState((s) => ({ ...s, phase: "outOfBook" }));
        return;
      }
      await new Promise((r) => setTimeout(r, OPPONENT_DELAY_MS));
      if (cancelled || currentFenRef.current !== fenAtStart) return;
      // `makeMove` branches from the pointer (`pathAtStart`), so the opponent's
      // reply lands on whatever line the user is on — mainline or a variation
      // entered via "best moves last turn".
      storeMakeMove({ payload: move });
      // Fresh reads: the tree was mutated and the pointer advanced to the new node.
      const freshRoot = store.getState().root;
      const newPath = store.getState().position;
      const newNode = getNodeAtPath(freshRoot, newPath);
      const [newPos] = positionFromFen(newNode.fen);
      if (newPos?.isEnd()) {
        setState((s) => ({ ...s, phase: "gameOver", result: describeResult(newPos) }));
      } else {
        setState((s) => ({
          ...s,
          phase: "waiting",
          fen: newNode.fen,
          path: newPath,
          priorScore: undefined,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.engineOpponentActive, currentNode.fen, source, token, minBookGames]);

  // Tear the opponent-engine process down when the user turns "Play on vs
  // engine" back off (Stop / New Game both clear `engineOpponentActive`).
  const prevEngineOpponentActiveRef = useRef(state.engineOpponentActive);
  useEffect(() => {
    const wasActive = prevEngineOpponentActiveRef.current;
    prevEngineOpponentActiveRef.current = state.engineOpponentActive;
    if (wasActive && !state.engineOpponentActive) {
      const oppId = opponentEngineIdRef.current;
      if (oppId) {
        commands.killEngine(`${oppId}-training-opponent`, activeTab ?? "").catch(() => {});
      }
    }
  }, [state.engineOpponentActive, activeTab]);

  // On unmount (tab closed, or switched away from) tear down the opponent
  // engine and unpin navigation. Do NOT reset the training atoms here: they are
  // `tabValue` atoms keyed on the *current* tab, which on a tab switch is
  // already the new tab (writing there is wrong) and on closing the last tab is
  // null (which throws "No tab selected"). Leaving the per-tab state intact also
  // lets a switched-away session resume when the tab is reopened.
  useEffect(() => {
    return () => {
      const oppId = opponentEngineIdRef.current;
      if (oppId) {
        commands.killEngine(`${oppId}-training-opponent`, activeTabRef.current).catch(() => {});
      }
      setPracticePath(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showBestNow = state.phase === "waiting" && state.priorScore !== undefined;
  const lastTurnPanel =
    state.lastTurn &&
    // Hide while the board is still on that position — right after an auto-undo
    // it would just repeat "best moves now". Shown once play has moved on.
    currentNode.fen !== state.lastTurn.fen &&
    (state.phase === "waiting" || state.phase === "outOfBook" || state.phase === "gameOver")
      ? state.lastTurn
      : null;

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
          training={!inSetup}
          trainingHintMoves={hintMoves}
        />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <Paper h="100%" withBorder p="md" style={{ overflow: "hidden" }}>
          {inSetup ? (
            <ScrollArea h="100%" offsetScrollbars>
              <Stack gap="md">
                <Text fw={600}>{t("Board.Training.Setup.Title", "Training setup")}</Text>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.StartPosition", "Start position")}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {t(
                        "Board.Training.Setup.StartPositionHint",
                        "Play your line on the board, or paste a FEN. Your last move is where training starts — the opponent replies first. Use Swap sides if the guessed side is wrong.",
                      )}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <TextInput
                        flex={1}
                        size="xs"
                        placeholder="rnbqkbnr/pppppppp/..."
                        value={fenInput}
                        error={fenError}
                        onChange={(e) => setFenInput(e.currentTarget.value)}
                      />
                      <Button size="xs" variant="light" onClick={loadFen}>
                        {t("Board.Training.Setup.LoadFen", "Load FEN")}
                      </Button>
                    </Group>
                    <Group gap="xs">
                      <Text fz="sm">
                        {t("Board.Training.PlayingAs", "Playing as {{color}}", {
                          color: color === "white" ? t("Fen.White") : t("Fen.Black"),
                        })}
                      </Text>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        onClick={() => setColor((c) => (c === "white" ? "black" : "white"))}
                        title={t("Board.Training.Setup.SwapSides", "Swap sides")}
                      >
                        <IconArrowsExchange size={16} />
                      </ActionIcon>
                    </Group>
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.EvalEngine", "Evaluation engine")}
                    </Text>
                    {hasLoadedEngine ? (
                      <>
                        <EngineConfigRow configAtom={trainingEvalEngineConfigAtom} />
                        <NumberInput
                          size="xs"
                          label={t("Board.Training.Setup.Movetime", "Time per evaluation (ms)")}
                          min={100}
                          step={100}
                          value={movetime}
                          onChange={(v) => setMovetime(typeof v === "number" ? v : 500)}
                        />
                      </>
                    ) : (
                      <Alert icon={<IconInfoCircle />} color="yellow">
                        {t("Board.Training.Setup.NoEngine", "Add and load a local engine first.")}{" "}
                        <Link to="/engines">{t("SideBar.Engines")}</Link>
                      </Alert>
                    )}
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.OpponentEngine", "Opponent engine (out of book)")}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {t(
                        "Board.Training.Setup.OpponentEngineHint",
                        "Used only when you choose “Play on” after the opening book runs out. Set its strength with the variant's engine options (e.g. Skill Level / UCI_Elo).",
                      )}
                    </Text>
                    {hasLoadedEngine ? (
                      <OpponentConfigRow />
                    ) : (
                      <Alert icon={<IconInfoCircle />} color="yellow">
                        {t("Board.Training.Setup.NoEngine", "Add and load a local engine first.")}{" "}
                        <Link to="/engines">{t("SideBar.Engines")}</Link>
                      </Alert>
                    )}
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.Book", "Opening book")}
                    </Text>
                    {token ? (
                      <>
                        <SegmentedControl
                          size="xs"
                          value={source}
                          onChange={(v) => setSource(v as "lichess" | "masters")}
                          data={[
                            { value: "lichess", label: t("Board.Practice.Build.SourceLichess") },
                            {
                              value: "masters",
                              label: t("Board.Practice.Build.SourceLichessMasters"),
                            },
                          ]}
                        />
                        <NumberInput
                          size="xs"
                          label={t("Board.Training.Setup.MinBookGames", "Leave book below N games")}
                          min={0}
                          value={minBookGames}
                          onChange={(v) => setMinBookGames(typeof v === "number" ? v : 0)}
                        />
                      </>
                    ) : (
                      <Alert icon={<IconInfoCircle />} color="yellow">
                        {t("Board.Database.ExplorerAuthRequired1")}{" "}
                        <Link to="/accounts">
                          {t("Board.Database.ExplorerAuthRequired.Accounts")}
                        </Link>{" "}
                        {t("Board.Database.ExplorerAuthRequired2")}
                      </Alert>
                    )}
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.Thresholds", "Thresholds")}
                    </Text>
                    <Group grow>
                      <NumberInput
                        size="xs"
                        label={t("Board.Training.Setup.MaxLossPawns", "Max eval loss (pawns)")}
                        min={0}
                        step={0.01}
                        decimalScale={2}
                        value={maxLossPawns}
                        onChange={(v) => setMaxLossPawns(typeof v === "number" ? v : 0.05)}
                      />
                      <NumberInput
                        size="xs"
                        label={t("Board.Training.Setup.MaxLossPct", "Max eval loss (%)")}
                        min={0}
                        max={100}
                        step={5}
                        value={maxLossPct}
                        onChange={(v) => setMaxLossPct(typeof v === "number" ? v : 40)}
                      />
                    </Group>
                    <Text fz="xs" c="dimmed">
                      {t(
                        "Board.Training.Setup.ThresholdRule",
                        "A move is undone if it loses more than {{pawns}} pawns and more than {{pct}}% of your current edge — whichever limit is larger.",
                        { pawns: maxLossPawns, pct: maxLossPct },
                      )}
                    </Text>
                  </Stack>
                </Paper>

                <Button
                  fullWidth
                  variant="light"
                  disabled={!hasLoadedEngine || !token}
                  onClick={startSession}
                >
                  {t("Board.Training.Setup.Start", "Start training")}
                </Button>
              </Stack>
            </ScrollArea>
          ) : (
            <ScrollArea h="100%" offsetScrollbars>
              <Stack gap="md">
                <SimpleGrid cols={2} spacing="xs">
                  <Paper p="xs" withBorder radius="sm">
                    <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                      {t("Board.Training.MovesPlayed", "Moves played")}
                    </Text>
                    <Text fz="lg" fw={700} c="green">
                      {stats.movesPlayed}
                    </Text>
                  </Paper>
                  <Paper p="xs" withBorder radius="sm">
                    <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                      {t("Board.Training.Mistakes", "Mistakes")}
                    </Text>
                    <Text fz="lg" fw={700} c="red">
                      {stats.mistakes}
                    </Text>
                  </Paper>
                </SimpleGrid>

                {state.phase === "waiting" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      {state.priorScore === undefined ? (
                        <Group gap="xs">
                          <Loader size="xs" />
                          <Text fz="sm" c="dimmed">
                            {t("Board.Training.Evaluating", "Evaluating…")}
                          </Text>
                        </Group>
                      ) : (
                        <>
                          <Text fz="sm" c="dimmed">
                            {t("Board.Training.YourMove", "Your move")}
                          </Text>
                          <Button variant="light" size="sm" fullWidth onClick={cycleHint}>
                            {hint.stage === 1
                              ? t("Board.Training.ShowArrows", "Show arrows")
                              : t("Board.Training.Hint", "Hint")}
                          </Button>
                        </>
                      )}
                      <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                        {t("Common.Stop")}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {state.phase === "checking" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Group gap="xs" justify="center">
                        <Loader size="xs" />
                        <Text fz="sm" c="dimmed">
                          {t("Board.Training.CheckingMove", "Checking your move…")}
                        </Text>
                      </Group>
                      <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                        {t("Common.Stop")}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {state.phase === "opponentThinking" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text fz="sm" c="dimmed">
                          {t("Board.Training.OpponentThinking", "Opponent is thinking…")}
                        </Text>
                      </Group>
                      <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                        {t("Common.Stop")}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {state.phase === "outOfBook" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Text fz="sm" c="dimmed" ta="center">
                        {t("Board.Training.OutOfBook", "Out of book.")}
                      </Text>
                      {opponentEngine && (
                        <Button
                          variant="light"
                          size="sm"
                          fullWidth
                          onClick={() =>
                            setState((s) => ({
                              ...s,
                              phase: "opponentThinking",
                              engineOpponentActive: true,
                            }))
                          }
                        >
                          {t("Board.Training.PlayOnVsEngine", "Play on vs {{engine}}", {
                            engine: opponentEngine.name,
                          })}
                        </Button>
                      )}
                      <Button variant="light" size="sm" fullWidth onClick={newGame}>
                        {t("Board.Training.NewGame", "New game")}
                      </Button>
                      <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                        {t("Common.Stop")}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {state.phase === "gameOver" && (
                  <Paper p="sm" withBorder>
                    <Stack gap="xs" align="center">
                      <Text fw={500}>
                        {t("Board.Training.GameOver", "Game over")} {state.result}
                      </Text>
                      <Button variant="light" size="sm" fullWidth onClick={newGame}>
                        {t("Board.Training.NewGame", "New game")}
                      </Button>
                      <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                        {t("Common.Stop")}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                {(showBestNow || lastTurnPanel) && (
                  <Group grow align="stretch" wrap="nowrap" gap="xs">
                    {showBestNow && (
                      <Paper p="xs" withBorder style={{ minWidth: 0 }}>
                        <Text fz="xs" fw={600} tt="uppercase" c="dimmed" mb={4}>
                          {t("Board.Training.BestNow", "Best moves now")}
                        </Text>
                        {hint.stage === 0 ? (
                          <Text fz="xs" c="dimmed">
                            {t(
                              "Board.Training.BestNowHidden",
                              "Press Hint to reveal the candidate moves.",
                            )}
                          </Text>
                        ) : currentCandidates.length > 0 ? (
                          <CandidateList moves={currentCandidates} />
                        ) : (
                          <Group gap="xs">
                            <Loader size="xs" />
                            <Text fz="xs" c="dimmed">
                              {t("Board.Training.Evaluating", "Evaluating…")}
                            </Text>
                          </Group>
                        )}
                      </Paper>
                    )}
                    {lastTurnPanel && (
                      <Paper p="xs" withBorder style={{ minWidth: 0 }}>
                        <Group justify="space-between" mb={4} wrap="nowrap">
                          <Text fz="xs" fw={600} tt="uppercase" c="dimmed">
                            {t("Board.Training.BestLastTurn", "Best moves last turn")}
                          </Text>
                          {lastTurnPanel.rejected && (
                            <Badge size="xs" color="red" variant="light">
                              {t("Board.Training.Undone", "undone")}
                            </Badge>
                          )}
                        </Group>
                        <Text fz="xs" c="dimmed" mb={4}>
                          {t(
                            "Board.Training.RedoHint",
                            "Pick a move to jump back and play it instead.",
                          )}
                        </Text>
                        <CandidateList
                          moves={lastTurnPanel.candidates}
                          playedUci={lastTurnPanel.playedUci}
                          onSelect={redoLastTurn}
                        />
                      </Paper>
                    )}
                  </Group>
                )}

                <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>
                  {color === "white" ? t("Fen.White") : t("Fen.Black")}
                </Badge>
              </Stack>
            </ScrollArea>
          )}
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <GameNotation
            topBar
            controls={
              <BoardControls
                editingMode={false}
                toggleEditingMode={() => {}}
                dirty={false}
                disableVariations
              />
            }
          />
          <MoveControls readOnly={!inSetup} />
        </Stack>
      </Portal>
    </>
  );
}

export default BoardTraining;
