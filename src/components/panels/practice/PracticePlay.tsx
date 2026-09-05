import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconCheck, IconInfoCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  currentInvisibleAtom,
  currentPracticeTabAtom,
  playHintAtom,
  playSessionStatsAtom,
  playStateAtom,
  repertoirePlaySourceAtom,
  sessionsAtom,
} from "@/state/atoms";
import { searchExplorerMoves } from "@/utils/db";
import { lineStatus, pickOpponentMove } from "@/utils/repertoirePlay";
import { getNodeAtPath } from "@/utils/treeReducer";

const OPPONENT_DELAY_MS = 400;
const EMPTY_PATH: number[] = [];

export default function PracticePlay() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const currentNode = useStore(store, (s) => s.currentNode());

  const [playState, setPlayState] = useAtom(playStateAtom);
  const [hint, setHint] = useAtom(playHintAtom);
  const [stats, setStats] = useAtom(playSessionStatsAtom);
  const [source, setSource] = useAtom(repertoirePlaySourceAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);
  const setTab = useSetAtom(currentPracticeTabAtom);
  const sessions = useAtomValue(sessionsAtom);

  const token = sessions.find((s) => s.lichess?.accessToken)?.lichess?.accessToken ?? null;
  const userColor = headers.orientation || "white";
  const startPath = headers.start ?? EMPTY_PATH;
  const userParity = userColor === "white" ? 0 : 1;

  const phase = playState.phase;
  const positionKey = position.join(",");
  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;

  const finish = useCallback(
    (status: "complete" | "gap") => {
      setInvisible(false);
      setHint({ stage: 0 });
      setPlayState({ phase: status === "gap" ? "gap" : "lineComplete" });
      if (status === "complete") {
        setStats((s) => ({ ...s, linesCompleted: s.linesCompleted + 1 }));
      }
    },
    [setInvisible, setHint, setPlayState, setStats],
  );

  const startGame = useCallback(() => {
    setHint({ stage: 0 });
    setInvisible(true);
    goToMove(startPath);
    const node = getNodeAtPath(root, startPath);
    const status = lineStatus(node, userColor);
    if (status !== "continue") {
      finish(status);
      return;
    }
    const userToMove = node.halfMoves % 2 === userParity;
    setPlayState({ phase: userToMove ? "waiting" : "opponentThinking" });
  }, [
    root,
    startPath,
    userColor,
    userParity,
    setHint,
    setInvisible,
    goToMove,
    setPlayState,
    finish,
  ]);

  const stopGame = useCallback(() => {
    setPlayState({ phase: "idle" });
    setHint({ stage: 0 });
    setInvisible(false);
    setStats({ linesCompleted: 0, mistakes: 0 });
  }, [setPlayState, setHint, setInvisible, setStats]);

  // The user just played a valid move (Board navigated the pointer). React to
  // where the pointer landed.
  useEffect(() => {
    if (phase !== "waiting") return;
    const userToMove = currentNode.halfMoves % 2 === userParity;
    if (userToMove) return; // still the user's turn — nothing happened yet
    setHint({ stage: 0 });
    const status = lineStatus(currentNode, userColor);
    if (status === "continue") {
      setPlayState({ phase: "opponentThinking" });
    } else {
      finish(status);
    }
  }, [phase, positionKey, currentNode, userColor, userParity, setHint, setPlayState, finish]);

  // Opponent's turn: fetch cached explorer stats, pick a reply, navigate.
  useEffect(() => {
    if (phase !== "opponentThinking") return;
    const fenAtStart = currentNode.fen;
    const pathAtStart = position;
    let cancelled = false;

    (async () => {
      const [statsForFen] = await searchExplorerMoves(source, [fenAtStart], token);
      if (cancelled || currentFenRef.current !== fenAtStart) return;
      const pick = pickOpponentMove(root, pathAtStart, statsForFen ?? []);
      await new Promise((r) => setTimeout(r, OPPONENT_DELAY_MS));
      if (cancelled || currentFenRef.current !== fenAtStart) return;

      if (!pick) {
        finish(
          lineStatus(getNodeAtPath(root, pathAtStart), userColor) === "gap" ? "gap" : "complete",
        );
        return;
      }
      goToMove(pick.nextPath);
      setHint({ stage: 0 });
      const status = lineStatus(getNodeAtPath(root, pick.nextPath), userColor);
      if (status === "continue") {
        setPlayState({ phase: "waiting" });
      } else {
        finish(status);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, positionKey, source, token, root, userColor, goToMove, setHint, setPlayState, finish]);

  // Keep the notation un-blurred whenever we are not mid-game.
  useEffect(() => {
    if (phase === "idle") setInvisible(false);
  }, [phase, setInvisible]);

  const cycleHint = useCallback(() => {
    setHint((h) => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }));
  }, [setHint]);

  useHotkeys("h", () => cycleHint(), { enabled: phase === "waiting" });

  const isRepertoireEmpty = root.children.length === 0;

  if (!token) {
    return (
      <Stack p="sm">
        <Alert icon={<IconInfoCircle />} color="yellow">
          {t("Board.Database.ExplorerAuthRequired1")}{" "}
          <Link to="/accounts">{t("Board.Database.ExplorerAuthRequired.Accounts")}</Link>{" "}
          {t("Board.Database.ExplorerAuthRequired2")}
        </Alert>
      </Stack>
    );
  }

  if (isRepertoireEmpty) {
    return (
      <Stack p="sm">
        <Alert icon={<IconInfoCircle />}>
          <Stack gap="xs">
            <Text fz="sm">{t("Board.Practice.Play.NeedMoves")}</Text>
            <Button variant="light" size="xs" onClick={() => setTab("build")}>
              {t("Board.Practice.GoToBuild")}
            </Button>
          </Stack>
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack p="sm" gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Text fz="xs" c="dimmed">
          {t("Board.Practice.Play.Source")}
        </Text>
        <SegmentedControl
          size="xs"
          value={source}
          onChange={(v) => setSource(v as "lichess" | "masters")}
          data={[
            { value: "lichess", label: t("Board.Practice.Build.SourceLichess") },
            { value: "masters", label: t("Board.Practice.Build.SourceLichessMasters") },
          ]}
        />
      </Group>

      <SimpleGrid cols={2} spacing="xs">
        <Paper p="xs" withBorder radius="sm">
          <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
            {t("Board.Practice.Play.LinesCompleted")}
          </Text>
          <Text fz="lg" fw={700} c="green">
            {stats.linesCompleted}
          </Text>
        </Paper>
        <Paper p="xs" withBorder radius="sm">
          <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
            {t("Board.Practice.Play.Mistakes")}
          </Text>
          <Text fz="lg" fw={700} c="red">
            {stats.mistakes}
          </Text>
        </Paper>
      </SimpleGrid>

      {phase === "idle" && (
        <Button size="md" variant="light" fullWidth onClick={startGame}>
          {t("Board.Practice.Play.StartPlaying")}
        </Button>
      )}

      {phase === "opponentThinking" && (
        <Paper p="sm" withBorder>
          <Group gap="xs" justify="center">
            <Loader size="xs" />
            <Text fz="sm" c="dimmed">
              {t("Board.Practice.Play.OpponentThinking")}
            </Text>
          </Group>
        </Paper>
      )}

      {phase === "waiting" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed">
              {t("Board.Practice.Play.YourMove")}
            </Text>
            <Button variant="light" size="sm" fullWidth onClick={cycleHint}>
              {hint.stage === 1
                ? t("Board.Practice.Play.ShowArrow")
                : t("Board.Practice.Play.Hint")}
            </Button>
            <Button variant="subtle" size="compact-xs" color="red" onClick={stopGame}>
              {t("Common.Stop")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "lineComplete" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <ThemeIcon size="xl" radius="xl" color="green" variant="light">
              <IconCheck size={24} />
            </ThemeIcon>
            <Text fw={500}>{t("Board.Practice.Play.LineComplete")}</Text>
            <Button variant="light" size="sm" fullWidth onClick={startGame}>
              {t("Board.Practice.Play.NewGame")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "gap" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed" ta="center">
              {t("Board.Practice.Play.OutOfBook")}
            </Text>
            <Button variant="subtle" size="xs" onClick={() => setTab("build")}>
              {t("Board.Practice.Play.GoToBuild")}
            </Button>
            <Button variant="light" size="sm" fullWidth onClick={startGame}>
              {t("Board.Practice.Play.NewGame")}
            </Button>
          </Stack>
        </Paper>
      )}

      <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>
        {userColor === "white" ? t("Fen.White") : t("Fen.Black")}
      </Badge>
    </Stack>
  );
}
