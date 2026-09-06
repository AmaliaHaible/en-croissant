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
import { IconArrowBack, IconCheck, IconInfoCircle } from "@tabler/icons-react";
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
import { isPrefix } from "@/utils/misc";
import { lineStatus, pickOpponentMove } from "@/utils/repertoirePlay";
import { findFen, getNodeAtPath } from "@/utils/treeReducer";

const OPPONENT_DELAY_MS = 400;
const EMPTY_PATH: number[] = [];

export default function PracticePlay() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
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
  const inGame = phase !== "idle";
  const activeTurn = phase === "waiting" || phase === "opponentThinking";
  const positionKey = position.join(",");
  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;

  // `expectedFen` / `gamePath` are the live game position. Scrubbing back and
  // forth along the game line (`position` a prefix of `gamePath`) is fine;
  // landing on a different branch (a move-list click) is "off the game".
  const expectedFen = playState.fen;
  const gamePath = playState.path;
  const offGamePosition =
    activeTurn &&
    gamePath !== undefined &&
    currentNode.fen !== expectedFen &&
    !isPrefix(position, gamePath);
  // Scrubbing back along the game line during your/opponent's turn — on the line,
  // just behind the live position.
  const reviewing =
    activeTurn && gamePath !== undefined && currentNode.fen !== expectedFen && !offGamePosition;

  const finish = useCallback(
    (status: "complete" | "gap", fen?: string, path?: number[]) => {
      setInvisible(false);
      setHint({ stage: 0 });
      // Keep fen/path (the final position) so forward/back still scrubs the
      // finished line without running off its end.
      setPlayState((s) => ({
        phase: status === "gap" ? "gap" : "lineComplete",
        fen: fen ?? s.fen,
        path: path ?? s.path,
      }));
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
      // A start position with no prepared moves is not a completed line —
      // surface it as a gap rather than crediting linesCompleted.
      finish(node.children.length === 0 ? "gap" : status);
      return;
    }
    const userToMove = node.halfMoves % 2 === userParity;
    setPlayState({
      phase: userToMove ? "waiting" : "opponentThinking",
      fen: node.fen,
      path: startPath,
    });
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

  // A prepared move was just played on the board (drag / click) — Board advanced
  // playState.fen/path to it. Plain navigation during your turn is not a move and
  // must not start an opponent turn.
  useEffect(() => {
    if (phase !== "waiting") return;
    const userToMove = currentNode.halfMoves % 2 === userParity;
    const playedOnBoard =
      expectedFen !== undefined && currentNode.fen === expectedFen && !userToMove;
    if (!playedOnBoard) return;
    setHint({ stage: 0 });
    const status = lineStatus(currentNode, userColor);
    if (status === "continue") {
      setPlayState((s) => ({ ...s, phase: "opponentThinking" }));
    } else {
      finish(status);
    }
  }, [
    phase,
    positionKey,
    currentNode,
    expectedFen,
    userColor,
    userParity,
    setHint,
    setPlayState,
    finish,
  ]);

  // Opponent's turn: fetch cached explorer stats, pick a reply, navigate.
  useEffect(() => {
    if (phase !== "opponentThinking") return;
    const fenAtStart = currentNode.fen;
    // The pointer wandered off the position the machine expects — don't think
    // from here. It will resume once the user navigates back (Board's lock keeps
    // them from moving in the meantime).
    if (playState.fen !== undefined && fenAtStart !== playState.fen) return;
    const pathAtStart = position;
    let cancelled = false;

    (async () => {
      // Total: `searchExplorerMoves` unwraps and throws on a Tauri command error
      // (e.g. a locked explorer cache). An empty list flows through
      // `pickOpponentMove` as all-EPSILON → uniform pick, so the game continues.
      const statsForFen = await searchExplorerMoves(source, [fenAtStart], token)
        .then((r) => r[0] ?? [])
        .catch(() => []);
      if (cancelled || currentFenRef.current !== fenAtStart) return;
      const pick = pickOpponentMove(root, pathAtStart, statsForFen);
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
      const nextNode = getNodeAtPath(root, pick.nextPath);
      const status = lineStatus(nextNode, userColor);
      if (status === "continue") {
        setPlayState({ phase: "waiting", fen: nextNode.fen, path: pick.nextPath });
      } else {
        finish(status, nextNode.fen, pick.nextPath);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, positionKey, source, token, root, userColor, goToMove, setHint, setPlayState, finish]);

  // Blur the notation while a game is in progress (also on returning to the tab
  // mid-game); un-blur once it is idle. `finish` handles lineComplete / gap.
  useEffect(() => {
    if (phase === "waiting" || phase === "opponentThinking") {
      setInvisible(true);
    } else if (phase === "idle") {
      setInvisible(false);
    }
  }, [phase, setInvisible]);

  // Pin forward/back navigation to the game line: the tree store's goToNext
  // follows practicePath's child indices and stops once the pointer reaches its
  // end, so `→` walks back to the live position and no further. BoardAnalysis
  // clears it when the Play tab is left.
  useEffect(() => {
    setPracticePath(inGame ? (gamePath ?? null) : null);
  }, [inGame, gamePath, setPracticePath]);

  const cycleHint = useCallback(() => {
    setHint((h) => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }));
  }, [setHint]);

  useHotkeys("h", cycleHint, { enabled: phase === "waiting" });

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

      {offGamePosition && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed" ta="center">
              {t("Board.Practice.NotOnPosition")}
            </Text>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconArrowBack size={14} />}
              onClick={() => goToMove(gamePath ?? findFen(expectedFen ?? "", root))}
            >
              {t("Board.Practice.GoBackToPosition")}
            </Button>
            <Button variant="subtle" size="compact-xs" color="red" onClick={stopGame}>
              {t("Common.Stop")}
            </Button>
          </Stack>
        </Paper>
      )}

      {reviewing && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed" ta="center">
              {t("Board.Practice.Play.Reviewing")}
            </Text>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconArrowBack size={14} />}
              onClick={() => gamePath && goToMove(gamePath)}
            >
              {t("Board.Practice.Play.BackToGame")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "opponentThinking" && !offGamePosition && !reviewing && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Group gap="xs" justify="center">
              <Loader size="xs" />
              <Text fz="sm" c="dimmed">
                {t("Board.Practice.Play.OpponentThinking")}
              </Text>
            </Group>
            <Button variant="subtle" size="compact-xs" color="red" onClick={stopGame}>
              {t("Common.Stop")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "waiting" && !offGamePosition && !reviewing && (
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
