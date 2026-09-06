import {
  ActionIcon,
  Alert,
  Badge,
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
import { IconArrowsExchange, IconInfoCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { Position } from "chessops";
import { parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import { useTrainingEngine } from "@/hooks/useTrainingEngine";
import { commands, type GoMode } from "@/bindings";
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
  trainingOpponentSkillAtom,
  trainingSessionStatsAtom,
  trainingStateAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { searchExplorerMoves } from "@/utils/db";
import { type LocalEngine, resolveConfiguredEngine } from "@/utils/engines";
import {
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

const OPPONENT_DELAY_MS = 400;

function describeResult(pos: Position): string {
  const outcome = pos.outcome();
  if (!outcome) return "*";
  if (outcome.winner === "white") return "1-0";
  if (outcome.winner === "black") return "0-1";
  return "½-½";
}

function EngineConfigRow({
  configAtom,
}: {
  configAtom: typeof trainingEvalEngineConfigAtom | typeof trainingOpponentEngineConfigAtom;
}) {
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

function BoardTraining() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, (s) => s.currentNode());
  const setFen = useStore(store, (s) => s.setFen);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const headers = useStore(store, (s) => s.headers);
  const appendMove = useStore(store, (s) => s.appendMove);
  const goToMove = useStore(store, (s) => s.goToMove);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const position = useStore(store, (s) => s.position);
  const root = useStore(store, (s) => s.root);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const { lines, resultFen } = useTrainingEngine(); // mounts the eval session for this tab

  const [state, setState] = useAtom(trainingStateAtom);
  const [color, setColor] = useAtom(trainingColorAtom);
  const [hint, setHint] = useAtom(trainingHintAtom);
  const [stats, setStats] = useAtom(trainingSessionStatsAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);
  const activeTab = useAtomValue(activeTabAtom);

  const [movetime, setMovetime] = useAtom(trainingEvalMovetimeAtom);
  const [skill, setSkill] = useAtom(trainingOpponentSkillAtom);
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

  function loadFen() {
    const parsed = parseFen(fenInput.trim());
    if (parsed.isErr) {
      setFenError(t("Board.Training.Setup.BadFen", "Not a valid FEN."));
      return;
    }
    setFenError(null);
    setFen(fenInput.trim());
    setColor(parsed.unwrap().turn);
  }

  function startSession() {
    const startFen = currentNode.fen;
    startFenRef.current = startFen;
    const [pos] = positionFromFen(startFen);
    // Design rule: your side is the side to move when you hit Start.
    const startColor = pos?.turn ?? color;
    setColor(startColor);
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: startColor });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(true);
    setState({
      phase: "waiting",
      fen: startFen,
      path: [],
      priorScore: undefined,
      checkParent: undefined,
      engineOpponentActive: false,
    });
  }

  function newGame() {
    const startFen = startFenRef.current;
    const [pos] = positionFromFen(startFen);
    const startColor = pos?.turn ?? color;
    setColor(startColor);
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: startColor });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(true);
    setState({
      phase: "waiting",
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

  const pickEngineOpponentMove = useCallback(
    async (fen: string, path: number[]): Promise<string | null> => {
      if (!opponentEngine) return null;
      const variant =
        opponentEngine.variants.find((v) => v.id === opponentConfig.variantId) ??
        opponentEngine.variants[0];
      const extraOptions = [
        ...(variant?.settings ?? []).map((s) => ({ name: s.name, value: String(s.value ?? "") })),
        { name: "MultiPV", value: "3" },
        ...(skill !== null ? [{ name: "Skill Level", value: String(skill) }] : []),
      ];
      const moves = getVariationLine(root, path);
      const go: GoMode = { t: "Time", c: 300 };
      const res = await commands.getBestMoves(
        `${opponentEngine.id}-training-opponent`,
        opponentEngine.path,
        activeTab ?? "",
        go,
        { fen, moves, extraOptions },
      );
      const data = res.status === "ok" ? res.data : null;
      const bestLines = data?.[1] ?? [];
      if (bestLines.length === 0) return null;
      // Favour the top move but allow the 2nd/3rd sometimes.
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
      return bestLines[idx]?.sanMoves[0] ?? bestLines[0].sanMoves[0] ?? null;
    },
    [opponentEngine, opponentConfig.variantId, skill, root, activeTab],
  );

  // Pin forward/back navigation to the played line.
  useEffect(() => {
    setPracticePath(state.phase !== "setup" ? (state.path ?? null) : null);
  }, [state.phase, state.path, setPracticePath]);

  // Blur notation during active play; restore otherwise.
  useEffect(() => {
    if (
      state.phase === "waiting" ||
      state.phase === "checking" ||
      state.phase === "opponentThinking"
    ) {
      setInvisible(true);
    } else {
      setInvisible(false);
    }
  }, [state.phase, setInvisible]);

  // waiting: capture the prior score once the engine answers for this position.
  useEffect(() => {
    if (state.phase !== "waiting" || state.priorScore !== undefined) return;
    if (resultFen !== currentNode.fen || lines.length === 0) return;
    setState((s) => ({ ...s, priorScore: scoreToCp(lines[0].score, userIsWhite) }));
  }, [state.phase, state.priorScore, resultFen, lines, currentNode.fen, userIsWhite, setState]);

  // checking: evaluate the move the user just played.
  useEffect(() => {
    if (state.phase !== "checking") return;
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
    }));
  }, [
    state.phase,
    state.priorScore,
    state.checkParent,
    resultFen,
    lines,
    currentNode.fen,
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
        san = await pickEngineOpponentMove(fenAtStart, pathAtStart);
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
      appendMove({ payload: move });
      // Fresh reads: `appendMove` mutated the tree and advanced the store's
      // position to the new node.
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

  // Reset everything when the tab unmounts (leaving Training).
  useEffect(() => {
    return () => {
      setState({ phase: "setup", engineOpponentActive: false });
      setHint({ stage: 0 });
      setInvisible(false);
      setPracticePath(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
          training={!inSetup}
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
                        "Play moves on the board, or paste a FEN. Training starts from the position shown.",
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
                    {hasLoadedEngine ? (
                      <>
                        <EngineConfigRow configAtom={trainingOpponentEngineConfigAtom} />
                        <NumberInput
                          size="xs"
                          label={t(
                            "Board.Training.Setup.OpponentSkill",
                            "Strength (Skill Level 0–20, blank = full)",
                          )}
                          min={0}
                          max={20}
                          value={skill ?? ""}
                          onChange={(v) => setSkill(typeof v === "number" ? v : null)}
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
                  <Group gap="xs" justify="center">
                    <Loader size="xs" />
                    <Text fz="sm" c="dimmed">
                      {t("Board.Training.CheckingMove", "Checking your move…")}
                    </Text>
                  </Group>
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

              <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>
                {color === "white" ? t("Fen.White") : t("Fen.Black")}
              </Badge>
            </Stack>
          )}
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <GameNotation />
          <MoveControls readOnly={!inSetup} />
        </Stack>
      </Portal>
    </>
  );
}

export default BoardTraining;
