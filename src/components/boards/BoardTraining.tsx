import {
  ActionIcon,
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Portal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconArrowsExchange, IconInfoCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { parseFen } from "chessops/fen";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import { useTrainingEngine } from "@/hooks/useTrainingEngine";
import {
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
import { positionFromFen } from "@/utils/chessops";
import { type LocalEngine, resolveConfiguredEngine } from "@/utils/engines";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";

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
  const boardRef = useRef<HTMLDivElement | null>(null);

  useTrainingEngine(); // mounts the eval session for this tab

  const [state, setState] = useAtom(trainingStateAtom);
  const [color, setColor] = useAtom(trainingColorAtom);
  const setHint = useSetAtom(trainingHintAtom);
  const setStats = useSetAtom(trainingSessionStatsAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);

  const [movetime, setMovetime] = useAtom(trainingEvalMovetimeAtom);
  const [skill, setSkill] = useAtom(trainingOpponentSkillAtom);
  const [source, setSource] = useAtom(trainingBookSourceAtom);
  const [minBookGames, setMinBookGames] = useAtom(trainingMinBookGamesAtom);
  const [maxLossPawns, setMaxLossPawns] = useAtom(trainingMaxLossPawnsAtom);
  const [maxLossPct, setMaxLossPct] = useAtom(trainingMaxLossPctAtom);

  const engines = useAtomValue(enginesAtom);
  const hasLoadedEngine = (engines ?? []).some((e) => e.type === "local" && e.loaded);
  const sessions = useAtomValue(sessionsAtom);
  const token = sessions.find((s) => s.lichess?.accessToken)?.lichess?.accessToken ?? null;

  const [fenInput, setFenInput] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);

  const inSetup = state.phase === "setup";

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
    const [pos] = positionFromFen(startFen);
    const userToMove = pos?.turn === color;
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: color });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(true);
    setState({
      phase: userToMove ? "waiting" : "opponentThinking",
      fen: startFen,
      path: [],
      priorScore: undefined,
      checkParent: undefined,
      engineOpponentActive: false,
    });
  }

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
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
            <Text c="dimmed">phase: {state.phase}</Text>
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
