import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFlag,
  IconInfoCircle,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import ConfirmModal from "@/components/common/ConfirmModal";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  coverageMinGamesAtom,
  currentPracticeTabAtom,
  currentTabAtom,
  referenceDbAtom,
} from "@/state/atoms";
import { searchPosition } from "@/utils/db";
import { roundKeepSum } from "@/utils/format";
import { isPrefix } from "@/utils/misc";
import {
  computeTreeCoverage,
  findBiggestGap,
  findNextGap,
  getStats,
  type PositionMove,
} from "@/utils/repertoire";
import { getNodeAtPath, getTreeStructureHash, type TreeNode } from "@/utils/treeReducer";
import classes from "./RepertoireInfo.module.css";

const EMPTY_PATH: number[] = [];

type ResponseStat = {
  san: string;
  halfMoves: number;
  dbGames: number;
  dbFrequency: number;
  white: number;
  draw: number;
  black: number;
  coverage: number;
  childPath: number[];
};

function formatMoveNotation(halfMoves: number, san: string): string {
  const moveNum = Math.ceil(halfMoves / 2);
  const isWhite = halfMoves % 2 === 1;
  return `${moveNum}${isWhite ? "." : "..."} ${san}`;
}

/** Number of moves stored below `node` (its whole subtree, node excluded). */
function countDescendantMoves(node: TreeNode): number {
  let total = 0;
  for (const child of node.children) {
    total += 1 + countDescendantMoves(child);
  }
  return total;
}

function RepertoireInfo() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const position = useStore(store, (s) => s.position);
  const currentNode = useStore(store, (s) => s.currentNode());
  const goToMove = useStore(store, (s) => s.goToMove);
  const makeMove = useStore(store, (s) => s.makeMove);
  const makeMoves = useStore(store, (s) => s.makeMoves);
  const replaceMove = useStore(store, (s) => s.replaceMove);
  const promoteVariation = useStore(store, (s) => s.promoteVariation);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const setStart = useStore(store, (s) => s.setStart);

  const referenceDb = useAtomValue(referenceDbAtom);
  const currentTab = useAtomValue(currentTabAtom);
  const minGames = useAtomValue(coverageMinGamesAtom);
  const practiceTab = useAtomValue(currentPracticeTabAtom);

  const orientation = headers.orientation || "white";

  const stats = useStore(store, getStats);

  const rootStructureHash = useMemo(() => getTreeStructureHash(root), [root]);
  // Recomputing coverage walks the whole repertoire and scans the reference
  // database for any position it has not seen before. While the user is adding
  // moves this hash changes on every ply, so debounce it: only recompute once
  // the repertoire stops changing, not once per keystroke.
  const [debouncedRootStructureHash] = useDebouncedValue(rootStructureHash, 500);

  const [rawOpenings, setRawOpenings] = useState<
    { move: string; white: number; draw: number; black: number }[]
  >([]);
  const [loading, setLoading] = useState(false);

  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;

  useEffect(() => {
    if (!referenceDb) {
      setRawOpenings([]);
      return;
    }

    const queryFen = currentNode.fen;
    setLoading(true);

    searchPosition(
      {
        path: referenceDb,
        type: "exact",
        fen: queryFen,
        color: "white",
        player: null,
        result: "any",
      },
      "build-tab",
    )
      .then(([openings]) => {
        if (queryFen !== currentFenRef.current) return;
        setRawOpenings(openings.filter((op) => op.move !== "*"));
        setLoading(false);
      })
      .catch(() => {
        if (queryFen !== currentFenRef.current) return;
        setRawOpenings([]);
        setLoading(false);
      });
  }, [currentNode.fen, referenceDb]);

  const [coverageMap, setCoverageMap] = useState<Map<string, number>>(new Map());
  const [gamesMap, setGamesMap] = useState<Map<string, number>>(new Map());
  const [missingGamesMap, setMissingGamesMap] = useState<Map<string, number>>(new Map());
  const [coverageLoading, setCoverageLoading] = useState(false);
  const coverageVersionRef = useRef(0);

  const startPath = headers.start || EMPTY_PATH;
  const startPathKey = startPath.join(",");
  const hasStart = headers.start != null && headers.start.length > 0;
  const isBeforeStart =
    hasStart && position.length < startPath.length && isPrefix(position, startPath);
  const isEmptyTree = root.children.length === 0;

  useEffect(() => {
    // Coverage only matters in the "build" view. Computing it walks the whole
    // repertoire, one sequential full-index reference-DB scan per position, so
    // it must not run just because the Practice tab is open for training.
    if (!referenceDb || practiceTab !== "build") {
      setCoverageMap(new Map());
      setGamesMap(new Map());
      setMissingGamesMap(new Map());
      setCoverageLoading(false);
      return;
    }
    const version = ++coverageVersionRef.current;
    const controller = new AbortController();
    setCoverageLoading(true);
    computeTreeCoverage(root, orientation, referenceDb, minGames, startPath, controller.signal)
      .then((result) => {
        if (version === coverageVersionRef.current) {
          setCoverageMap(result.coverageMap);
          setGamesMap(result.gamesMap);
          setMissingGamesMap(result.missingGamesMap);
          setCoverageLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && version === coverageVersionRef.current) {
          setCoverageLoading(false);
        }
      });
    return () => controller.abort();
  }, [debouncedRootStructureHash, orientation, referenceDb, startPathKey, minGames, practiceTab]);

  const positionMoves = useMemo(() => {
    const total = rawOpenings.reduce((acc, op) => acc + op.white + op.black + op.draw, 0);

    const fromDb: PositionMove[] = rawOpenings
      .map((op) => {
        const games = op.white + op.black + op.draw;
        const childIndex = currentNode.children.findIndex((c) => c.san === op.move);
        const inRepertoire = childIndex !== -1;
        const coveragePath = [...position, childIndex].join(",");
        const coverage = inRepertoire ? (coverageMap.get(coveragePath) ?? 0) : 0;

        return {
          san: op.move,
          games,
          totalGames: total,
          frequency: total > 0 ? games / total : 0,
          white: games > 0 ? op.white / games : 0,
          draw: games > 0 ? op.draw / games : 0,
          black: games > 0 ? op.black / games : 0,
          inRepertoire,
          coverage,
          childIndex,
        };
      })
      .sort((a, b) => b.frequency - a.frequency);

    // Include repertoire children not found in the DB
    const dbSans = new Set(rawOpenings.map((op) => op.move));
    const fromTree: PositionMove[] = currentNode.children
      .map((child, idx) => ({ child, idx }))
      .filter(
        (entry): entry is { child: TreeNode & { san: string }; idx: number } =>
          entry.child.san !== null && !dbSans.has(entry.child.san),
      )
      .map(({ child, idx }) => {
        const coveragePath = [...position, idx].join(",");
        return {
          san: child.san,
          games: 0,
          totalGames: total,
          frequency: 0,
          white: 0,
          draw: 0,
          black: 0,
          inRepertoire: true,
          coverage: coverageMap.get(coveragePath) ?? 0,
          childIndex: idx,
        };
      });

    return [...fromDb, ...fromTree];
  }, [rawOpenings, currentNode.children, position, coverageMap]);

  const isUserTurn =
    orientation === "white" ? currentNode.halfMoves % 2 === 0 : currentNode.halfMoves % 2 === 1;

  const handleMoveClick = useCallback(
    (move: PositionMove) => {
      if (move.inRepertoire) {
        goToMove([...position, move.childIndex]);
      } else {
        makeMove({ payload: move.san });
      }
    },
    [position, goToMove, makeMove],
  );

  const nextGap = useMemo(
    () => findNextGap(root, position, orientation, coverageMap, gamesMap, minGames),
    [root, position, orientation, coverageMap, gamesMap, minGames],
  );

  const biggestGap = useMemo(
    () =>
      findBiggestGap(
        root,
        orientation,
        coverageMap,
        gamesMap,
        missingGamesMap,
        minGames,
        startPath,
      ),
    [root, orientation, coverageMap, gamesMap, missingGamesMap, startPath, minGames],
  );

  if (!currentTab) return null;

  if (!referenceDb) {
    return (
      <Stack p="sm">
        <TreeStatsBar stats={stats} t={t} />
        <Alert icon={<IconInfoCircle />}>{t("Board.Practice.Build.NoRefDb")}</Alert>
      </Stack>
    );
  }

  return (
    <Stack h="100%" p="sm" gap={0} style={{ overflow: "hidden" }}>
      {isBeforeStart && (
        <Paper p="sm" my="sm" withBorder>
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              {t("Board.Practice.Build.BeforeStart")}
            </Text>
            <Button
              leftSection={<IconPlayerPlay size={16} />}
              variant="light"
              size="xs"
              onClick={() => goToMove(startPath)}
            >
              {t("Board.Practice.Build.GoToStart")}
            </Button>
          </Stack>
        </Paper>
      )}

      {!hasStart && !isEmptyTree && (
        <Paper p="sm" my="sm" withBorder>
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              {t("Board.Practice.MarkStart")}
            </Text>
            <Button
              leftSection={<IconFlag size={16} />}
              variant="light"
              size="xs"
              onClick={() => setStart(position)}
            >
              {t("Board.Practice.Build.SetAsStart")}
            </Button>
          </Stack>
        </Paper>
      )}

      {isEmptyTree && position.length === 0 && (
        <Paper p="sm" my="sm" withBorder>
          <Stack gap="xs">
            <Text fz="sm" fw={600}>
              {t("Board.Practice.Build.Presets")}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("Board.Practice.Build.PresetsDesc")}
            </Text>
            <Stack gap={4}>
              {(orientation === "white"
                ? [
                    {
                      name: "Italian Game",
                      moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
                    },
                    {
                      name: "Ruy Lopez",
                      moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"],
                    },
                    { name: "Catalan", moves: ["d4", "Nf6", "c4", "e6", "g3"] },
                  ]
                : [
                    { name: "French Defense", moves: ["e4", "e6", "d4", "d5"] },
                    { name: "King's Indian", moves: ["d4", "Nf6", "c4", "g6"] },
                    {
                      name: "Najdorf",
                      moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"],
                    },
                  ]
              ).map((preset) => (
                <Button
                  key={preset.name}
                  variant="default"
                  size="xs"
                  justify="start"
                  onClick={() => {
                    makeMoves({ payload: preset.moves });
                    setStart(Array(preset.moves.length).fill(0));
                  }}
                >
                  {preset.name}
                </Button>
              ))}
            </Stack>
          </Stack>
        </Paper>
      )}

      {loading ? (
        <Stack align="center" justify="center" style={{ flex: 1 }} py="xl">
          <Loader size="sm" />
          <Text fz="sm" c="dimmed">
            {t("Board.Practice.Build.Loading")}
          </Text>
        </Stack>
      ) : (
        <MovesView
          isUserTurn={isUserTurn}
          currentNode={currentNode}
          position={position}
          positionMoves={positionMoves}
          coverageMap={coverageMap}
          coverageLoading={coverageLoading}
          root={root}
          nextGap={nextGap}
          biggestGap={biggestGap}
          goToMove={goToMove}
          onMoveClick={handleMoveClick}
          makeMove={makeMove}
          replaceMove={replaceMove}
          promoteVariation={promoteVariation}
          deleteMove={deleteMove}
          t={t}
          minGames={minGames}
        />
      )}
      <Divider pb="sm" />
      <TreeStatsBar stats={stats} t={t} />
    </Stack>
  );
}

function TreeStatsBar({
  stats,
  t,
}: {
  stats: { leafs: number; depth: number; total: number };
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <Group gap="md">
      <Text fz="xs" c="dimmed">
        {t("Board.Practice.Variations")}: {stats.leafs}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("Board.Practice.MaxDepth")}: {stats.depth}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("Board.Practice.TotalMoves")}: {stats.total}
      </Text>
    </Group>
  );
}

function MovesView({
  isUserTurn,
  currentNode,
  position,
  positionMoves,
  coverageMap,
  coverageLoading,
  root,
  nextGap,
  biggestGap,
  goToMove,
  onMoveClick,
  makeMove,
  replaceMove,
  promoteVariation,
  deleteMove,
  t,
  minGames,
}: {
  isUserTurn: boolean;
  currentNode: TreeNode;
  position: number[];
  positionMoves: PositionMove[];
  coverageMap: Map<string, number>;
  coverageLoading: boolean;
  root: TreeNode;
  nextGap: number[] | null;
  biggestGap: number[] | null;
  goToMove: (path: number[]) => void;
  onMoveClick: (move: PositionMove) => void;
  makeMove: (args: { payload: string }) => void;
  replaceMove: (args: { payload: string; at?: number[] }) => void;
  promoteVariation: (path: number[]) => void;
  deleteMove: (path: number[]) => void;
  t: ReturnType<typeof useTranslation>["t"];
  minGames: number;
}) {
  const hasResponses = currentNode.children.length > 0;
  const [showRare, setShowRare] = useState(false);

  const responsesWithStats = useMemo(() => {
    if (!isUserTurn || !hasResponses) return [];
    return currentNode.children.map((child, idx) => {
      const dbEntry = positionMoves.find((pm) => pm.san === child.san);
      const coveragePath = [...position, idx].join(",");
      const coverage = coverageMap.get(coveragePath) ?? 0;
      return {
        san: child.san || "",
        halfMoves: child.halfMoves,
        dbGames: dbEntry?.games ?? 0,
        dbFrequency: dbEntry?.frequency ?? 0,
        white: dbEntry?.white ?? 0,
        draw: dbEntry?.draw ?? 0,
        black: dbEntry?.black ?? 0,
        coverage,
        childPath: [...position, idx],
      };
    });
  }, [isUserTurn, hasResponses, currentNode.children, positionMoves, position, coverageMap]);

  const relevantMoves = useMemo(
    () => (isUserTurn ? [] : positionMoves.filter((m) => m.games >= minGames)),
    [isUserTurn, positionMoves, minGames],
  );
  const rareMoves = useMemo(
    () => (isUserTurn ? [] : positionMoves.filter((m) => m.games < minGames)),
    [isUserTurn, positionMoves, minGames],
  );

  const nextGapLabel = useMemo(() => {
    if (!nextGap) return null;
    const node = getNodeAtPath(root, nextGap);
    return node.san ? formatMoveNotation(node.halfMoves, node.san) : null;
  }, [nextGap, root]);

  const biggestGapLabel = useMemo(() => {
    if (!biggestGap) return null;
    const node = getNodeAtPath(root, biggestGap);
    return node.san ? formatMoveNotation(node.halfMoves, node.san) : null;
  }, [biggestGap, root]);

  const title = isUserTurn
    ? t("Board.Practice.Build.YourResponse")
    : t("Board.Practice.Build.OpponentMoves");

  if (positionMoves.length === 0 && !hasResponses) {
    return (
      <ScrollArea style={{ flex: 1 }} pt="sm">
        <Stack gap="md">
          <Stack align="center" py="xl">
            <Text c="dimmed" fz="sm">
              {t("Board.Practice.Build.NoMovesFound")}
            </Text>
          </Stack>
          {coverageLoading ? (
            <>
              <Divider />
              <Group justify="center" py="sm" gap="xs">
                <Loader size={12} />
                <Text fz="xs" c="dimmed">
                  {t("Board.Practice.Build.Loading")}
                </Text>
              </Group>
            </>
          ) : (
            (nextGap || biggestGap) && (
              <>
                <Divider />
                <Stack gap={0}>
                  {nextGap && (
                    <GapButton
                      label={t("Board.Practice.Build.NextGap")}
                      detail={nextGapLabel}
                      onClick={() => goToMove(nextGap)}
                    />
                  )}
                  {biggestGap && (
                    <GapButton
                      label={t("Board.Practice.Build.BiggestGap")}
                      detail={biggestGapLabel}
                      onClick={() => goToMove(biggestGap)}
                    />
                  )}
                </Stack>
              </>
            )
          )}
        </Stack>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }} pt="sm">
      <Stack gap="md">
        <Stack gap={0}>
          <Group justify="space-between" mb={4} px="xs">
            <Text fz="xs" fw={600} style={{ flex: 1 }}>
              {title}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Text fz="xs" c="dimmed" w={50} ta="center">
                %
              </Text>
              <Text fz="xs" c="dimmed" w={70} ta="center">
                {t("Common.Games")}
              </Text>
              <Text fz="xs" c="dimmed" w={100} ta="center">
                {t("Board.Practice.Build.Results")}
              </Text>
              {hasResponses && (
                <Group gap={4} w={100} justify="center" wrap="nowrap">
                  <Text fz="xs" c="dimmed" ta="center">
                    {t("Board.Practice.Build.YourCoverage")}
                  </Text>
                  {coverageLoading && <Loader size={10} />}
                </Group>
              )}
            </Group>
          </Group>

          {isUserTurn && (
            <UserResponseSection
              currentNode={currentNode}
              position={position}
              positionMoves={positionMoves}
              responsesWithStats={responsesWithStats}
              goToMove={goToMove}
              makeMove={makeMove}
              replaceMove={replaceMove}
              promoteVariation={promoteVariation}
              deleteMove={deleteMove}
              minGames={minGames}
              t={t}
            />
          )}

          {!isUserTurn &&
            relevantMoves.map((move) => (
              <MoveRow
                key={move.san}
                move={move}
                halfMoves={currentNode.halfMoves + 1}
                onClick={() => onMoveClick(move)}
                dimmed={false}
                minGames={minGames}
              />
            ))}

          {!isUserTurn && rareMoves.length > 0 && relevantMoves.length > 0 && (
            <UnstyledButton
              onClick={() => setShowRare((v) => !v)}
              px="xs"
              py={6}
              style={{ width: "100%" }}
            >
              <Group gap="xs" justify="center">
                <Divider style={{ flex: 1 }} />
                <Group gap={4} wrap="nowrap">
                  {showRare ? (
                    <IconChevronDown size={12} color="var(--mantine-color-dimmed)" />
                  ) : (
                    <IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
                  )}
                  <Text fz="xs" c="dimmed">
                    {t("Board.Practice.Build.RareMoves")}
                  </Text>
                </Group>
                <Divider style={{ flex: 1 }} />
              </Group>
            </UnstyledButton>
          )}

          {!isUserTurn &&
            (showRare || relevantMoves.length === 0) &&
            rareMoves.map((move) => (
              <MoveRow
                key={move.san}
                move={move}
                halfMoves={currentNode.halfMoves + 1}
                onClick={() => onMoveClick(move)}
                dimmed
                minGames={minGames}
              />
            ))}
        </Stack>

        {coverageLoading ? (
          <>
            <Divider />
            <Group justify="center" py="sm" gap="xs">
              <Loader size={12} />
              <Text fz="xs" c="dimmed">
                {t("Board.Practice.Build.Loading")}
              </Text>
            </Group>
          </>
        ) : (
          <>
            {(nextGap || biggestGap) && (
              <>
                <Divider />
                <Stack gap={0}>
                  {nextGap && (
                    <GapButton
                      label={t("Board.Practice.Build.NextGap")}
                      detail={nextGapLabel}
                      onClick={() => goToMove(nextGap)}
                    />
                  )}
                  {biggestGap && (
                    <GapButton
                      label={t("Board.Practice.Build.BiggestGap")}
                      detail={biggestGapLabel}
                      onClick={() => goToMove(biggestGap)}
                    />
                  )}
                </Stack>
              </>
            )}

            {!nextGap && !biggestGap && (isUserTurn ? hasResponses : positionMoves.length > 0) && (
              <>
                <Divider />
                <Paper p="sm" withBorder>
                  <Group gap="xs" justify="center">
                    <ThemeIcon size="sm" color="green" variant="light" radius="xl">
                      <IconCheck size={14} />
                    </ThemeIcon>
                    <Text fz="sm" c="green" fw={500}>
                      {t("Board.Practice.Build.NoGapsFound")}
                    </Text>
                  </Group>
                </Paper>
              </>
            )}
          </>
        )}
      </Stack>
    </ScrollArea>
  );
}

function getCoverageColor(coverage: number): string {
  if (coverage <= 0) return "gray";
  if (coverage < 0.33) return "red";
  if (coverage < 0.67) return "yellow";
  return "green";
}

function MoveRow({
  move,
  halfMoves,
  onClick,
  dimmed,
  showCoverage = true,
  minGames,
  badge,
}: {
  move: PositionMove;
  halfMoves: number;
  onClick: () => void;
  dimmed: boolean;
  showCoverage?: boolean;
  minGames: number;
  badge?: string;
}) {
  const { t } = useTranslation();
  const notation = formatMoveNotation(halfMoves, move.san);
  const coverageColor = getCoverageColor(move.coverage);
  const pct = move.frequency > 0 ? `${(move.frequency * 100).toFixed(0)}%` : "—";
  const [wPct, dPct, bPct] = roundKeepSum([move.white * 100, move.draw * 100, move.black * 100]);

  return (
    <UnstyledButton
      onClick={onClick}
      py="sm"
      px="xs"
      className={classes.moveRow}
      style={{
        borderBottom: "1px solid var(--mantine-color-dark-5)",
        borderRadius: 0,
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} fz="sm">
            {notation}
          </Text>
          {move.inRepertoire && !badge && (
            <ThemeIcon size="xs" color="green" variant="transparent">
              <IconCheck size={12} />
            </ThemeIcon>
          )}
          {badge && (
            <Badge size="xs" color="green" variant="light">
              {badge}
            </Badge>
          )}
        </Group>

        <Group gap="xs" wrap="nowrap">
          <Text fz="sm" c="dimmed" w={50} ta="center">
            {pct}
          </Text>
          <Text fz="sm" c="dimmed" w={70} ta="center">
            {move.games > 0 ? move.games.toLocaleString() : "—"}
          </Text>
          <Tooltip label={`${wPct}% / ${dPct}% / ${bPct}%`} position="top" withArrow>
            <Progress.Root size="xl" w={100}>
              <Progress.Section value={wPct} color="white">
                {wPct > 20 && <Progress.Label c="black">{wPct}</Progress.Label>}
              </Progress.Section>
              <Progress.Section value={dPct} color="gray">
                {dPct > 20 && <Progress.Label>{dPct}</Progress.Label>}
              </Progress.Section>
              <Progress.Section value={bPct} color="dark">
                {bPct > 20 && <Progress.Label>{bPct}</Progress.Label>}
              </Progress.Section>
            </Progress.Root>
          </Tooltip>
          {showCoverage && (
            <Box w={100}>
              {dimmed || move.games < minGames ? (
                <Tooltip label={t("Board.Practice.Build.RareTooltip")} withArrow>
                  <Text fz="xs" c="dimmed" ta="center">
                    N/A
                  </Text>
                </Tooltip>
              ) : (
                <Progress
                  value={move.inRepertoire ? Math.max(move.coverage * 100, 3) : 0}
                  color={coverageColor}
                  size="sm"
                  radius="xl"
                />
              )}
            </Box>
          )}
        </Group>
      </Group>
    </UnstyledButton>
  );
}

function UserResponseSection({
  currentNode,
  position,
  positionMoves,
  responsesWithStats,
  goToMove,
  makeMove,
  replaceMove,
  promoteVariation,
  deleteMove,
  minGames,
  t,
}: {
  currentNode: TreeNode;
  position: number[];
  positionMoves: PositionMove[];
  responsesWithStats: ResponseStat[];
  goToMove: (path: number[]) => void;
  makeMove: (args: { payload: string }) => void;
  replaceMove: (args: { payload: string; at?: number[] }) => void;
  promoteVariation: (path: number[]) => void;
  deleteMove: (path: number[]) => void;
  minGames: number;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    san: string;
    path: number[];
    count: number;
  } | null>(null);
  const [showRare, setShowRare] = useState(false);

  const hasResponses = responsesWithStats.length > 0;
  const active = responsesWithStats[0];
  const alternatives = responsesWithStats.slice(1);

  const toRow = (r: ResponseStat): PositionMove => ({
    san: r.san,
    games: r.dbGames,
    totalGames: 0,
    frequency: r.dbFrequency,
    white: r.white,
    draw: r.draw,
    black: r.black,
    inRepertoire: true,
    coverage: r.coverage,
    childIndex: 0,
  });

  const repertoireSans = new Set(responsesWithStats.map((r) => r.san));
  const candidates = positionMoves.filter((m) => !repertoireSans.has(m.san));
  const relevantCandidates = candidates.filter((m) => m.games >= minGames);
  const rareCandidates = candidates.filter((m) => m.games < minGames);

  // Everything stored below the current position is discarded when the user
  // swaps in a move that is not already one of the candidates here.
  const lostMoveCount = countDescendantMoves(currentNode);

  function pickCandidate(san: string) {
    if (hasResponses) {
      setReplaceTarget(san);
    } else {
      makeMove({ payload: san });
    }
  }

  return (
    <>
      {hasResponses && (
        <>
          <MoveRow
            move={toRow(active)}
            halfMoves={active.halfMoves}
            onClick={() => goToMove(active.childPath)}
            dimmed={false}
            showCoverage
            minGames={minGames}
            badge={t("Board.Practice.Build.ActiveMove")}
          />
          {alternatives.length > 0 && (
            <>
              <Text fz="xs" c="dimmed" px="xs" pt="xs">
                {t("Board.Practice.Build.Alternatives")}
              </Text>
              {alternatives.map((alt) => {
                const childNode = currentNode.children[alt.childPath[alt.childPath.length - 1]];
                return (
                  <Group
                    key={alt.san}
                    justify="space-between"
                    wrap="nowrap"
                    px="xs"
                    py={6}
                    style={{ borderBottom: "1px solid var(--mantine-color-dark-5)" }}
                  >
                    <UnstyledButton
                      onClick={() => goToMove(alt.childPath)}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <Text fw={700} fz="sm">
                        {formatMoveNotation(alt.halfMoves, alt.san)}
                      </Text>
                    </UnstyledButton>
                    <Group gap={4} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => promoteVariation(alt.childPath)}
                      >
                        {t("Board.Practice.Build.MakeActive")}
                      </Button>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          setDeleteTarget({
                            san: alt.san,
                            path: alt.childPath,
                            count: childNode ? 1 + countDescendantMoves(childNode) : 1,
                          })
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  </Group>
                );
              })}
            </>
          )}
        </>
      )}

      <Text fz="xs" fw={600} px="xs" pt="sm" pb={4}>
        {hasResponses
          ? t("Board.Practice.Build.ChangeMovePrompt")
          : t("Board.Practice.Build.PickMovePrompt")}
      </Text>

      {relevantCandidates.map((move) => (
        <MoveRow
          key={move.san}
          move={move}
          halfMoves={currentNode.halfMoves + 1}
          onClick={() => pickCandidate(move.san)}
          dimmed={false}
          showCoverage={false}
          minGames={minGames}
        />
      ))}

      {rareCandidates.length > 0 && (
        <UnstyledButton
          onClick={() => setShowRare((v) => !v)}
          px="xs"
          py={6}
          style={{ width: "100%" }}
        >
          <Group gap="xs" justify="center">
            <Divider style={{ flex: 1 }} />
            <Group gap={4} wrap="nowrap">
              {showRare ? (
                <IconChevronDown size={12} color="var(--mantine-color-dimmed)" />
              ) : (
                <IconChevronRight size={12} color="var(--mantine-color-dimmed)" />
              )}
              <Text fz="xs" c="dimmed">
                {t("Board.Practice.Build.RareMoves")}
              </Text>
            </Group>
            <Divider style={{ flex: 1 }} />
          </Group>
        </UnstyledButton>
      )}

      {(showRare || relevantCandidates.length === 0) &&
        rareCandidates.map((move) => (
          <MoveRow
            key={move.san}
            move={move}
            halfMoves={currentNode.halfMoves + 1}
            onClick={() => pickCandidate(move.san)}
            dimmed
            showCoverage={false}
            minGames={minGames}
          />
        ))}

      <ConfirmModal
        opened={replaceTarget !== null}
        title={t("Board.Practice.Build.ChangeMoveTitle")}
        description={
          lostMoveCount > 0
            ? t("Board.Practice.Build.ReplaceConfirm", {
                move: replaceTarget ?? "",
                count: lostMoveCount,
              })
            : t("Board.Practice.Build.ReplaceConfirmEmpty", { move: replaceTarget ?? "" })
        }
        confirmLabel={t("Board.Practice.Build.Replace")}
        onClose={() => setReplaceTarget(null)}
        onConfirm={() => {
          if (replaceTarget) replaceMove({ payload: replaceTarget, at: position });
          setReplaceTarget(null);
        }}
      />
      <ConfirmModal
        opened={deleteTarget !== null}
        title={t("Common.Delete")}
        description={t("Board.Practice.Build.DeleteAltConfirm", {
          move: deleteTarget?.san ?? "",
          count: deleteTarget?.count ?? 0,
        })}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMove(deleteTarget.path);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

function GapButton({
  label,
  detail,
  onClick,
}: {
  label: string;
  detail: string | null;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      py="sm"
      px="xs"
      style={{
        borderBottom: "1px solid var(--mantine-color-dark-5)",
        borderRadius: 0,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text fz="sm" fw={500}>
          {label}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {detail && (
            <Text fz="sm" c="dimmed">
              {detail}
            </Text>
          )}
          <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}

export default RepertoireInfo;
