import { ActionIcon, Box, Menu, Portal, Text, Tooltip } from "@mantine/core";
import {
  IconArrowsJoin,
  IconChevronsUp,
  IconChevronUp,
  IconCopy,
  IconFlag,
  IconX,
} from "@tabler/icons-react";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import Comment from "@/components/common/Comment";
import { currentTabAtom } from "@/state/atoms";
import type { Annotation } from "@/utils/annotation";
import { hasMorePriority, stripClock } from "@/utils/chess";
import { getTabFile } from "@/utils/tabs";
import { type TreeNode, treeIterator } from "@/utils/treeReducer";
import MoveCell from "./MoveCell";
import { TreeStateContext } from "./TreeStateContext";

const transpositionCache = new WeakMap<TreeNode, Map<string, number[][]>>();

function getTranspositionMap(root: TreeNode) {
  if (transpositionCache.has(root)) {
    return transpositionCache.get(root)!;
  }

  const map = new Map<string, number[][]>();
  const iterator = treeIterator(root);

  for (const item of iterator) {
    const strippedFen = stripClock(item.node.fen);
    if (!map.has(strippedFen)) {
      map.set(strippedFen, []);
    }
    map.get(strippedFen)!.push(item.position);
  }

  transpositionCache.set(root, map);
  return map;
}

function getTranspositions(fen: string, position: number[], root: TreeNode) {
  if (position.length === 0 || position.every((v) => v === 0)) return [];

  const map = getTranspositionMap(root);
  const strippedFen = stripClock(fen);

  const matchingPositions = map.get(strippedFen) || [];

  return matchingPositions.filter((targetPosition) => !hasMorePriority(position, targetPosition));
}

// The menu's contents (and everything they need: i18n, the current tab atom,
// several store actions) are split out into their own component so that
// they only ever mount for the cell whose menu is actually open, instead of
// for every move in the game.
function MoveContextMenuItems({ movePath }: { movePath: number[] }) {
  const store = useContext(TreeStateContext)!;
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const promoteVariation = useStore(store, (s) => s.promoteVariation);
  const promoteToMainline = useStore(store, (s) => s.promoteToMainline);
  const copyVariationPgn = useStore(store, (s) => s.copyVariationPgn);
  const setStart = useStore(store, (s) => s.setStart);
  const currentTab = useAtomValue(currentTabAtom);
  const tabFile = getTabFile(currentTab);
  const { t } = useTranslation();

  return (
    <Menu.Dropdown>
      {tabFile?.metadata.type === "repertoire" && (
        <Menu.Item leftSection={<IconFlag size="0.875rem" />} onClick={() => setStart(movePath)}>
          {t("Menu.MarkAsStart")}
        </Menu.Item>
      )}
      <Menu.Item
        leftSection={<IconChevronsUp size="0.875rem" />}
        onClick={() => promoteToMainline(movePath)}
      >
        {t("Menu.PromoteToMainLine")}
      </Menu.Item>

      <Menu.Item
        leftSection={<IconChevronUp size="0.875rem" />}
        onClick={() => promoteVariation(movePath)}
      >
        {t("Menu.PromoteVariation")}
      </Menu.Item>

      <Menu.Item
        leftSection={<IconCopy size="0.875rem" />}
        onClick={() => copyVariationPgn(movePath)}
      >
        {t("Menu.CopyVariationPGN")}
      </Menu.Item>

      <Menu.Item
        color="red"
        leftSection={<IconX size="0.875rem" />}
        onClick={() => deleteMove(movePath)}
      >
        {t("Menu.DeleteMove")}
      </Menu.Item>
    </Menu.Dropdown>
  );
}

function CompleteMoveCell({
  movePath,
  halfMoves,
  move,
  fen,
  comment,
  annotations,
  showComments,
  first,
  targetRef,
  tableLayout,
  scoreText,
}: {
  halfMoves: number;
  comment: string;
  annotations: Annotation[];
  showComments: boolean;
  move?: string | null;
  fen?: string;
  first?: boolean;
  movePath: number[];
  targetRef: React.RefObject<HTMLSpanElement | null>;
  tableLayout?: boolean;
  scoreText?: string;
}) {
  const store = useContext(TreeStateContext)!;
  const isStart = useStore(store, (s) => equal(movePath, s.headers.start));

  const isCurrentVariation = useStore(store, (s) => equal(s.position, movePath));
  const transpositions = useStoreWithEqualityFn(
    store,
    (s) => (fen ? getTranspositions(fen, movePath, s.root) : []),
    (a, b) => equal(a, b),
  );

  const moveNumber = Math.ceil(halfMoves / 2);
  const isWhite = halfMoves % 2 === 1;
  const hasNumber = !tableLayout && halfMoves > 0 && (first || isWhite);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Only listen for outside clicks while this cell's menu is actually open,
  // instead of Mantine's useClickOutside (which would register a permanent
  // document listener per cell — very expensive with thousands of moves).
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [open]);

  const onContextMenu = (e: React.MouseEvent) => {
    setOpen((v) => !v);
    e.preventDefault();
  };
  const onClick = () => store.getState().goToMove(movePath);
  const rightAccessory =
    tableLayout && scoreText ? (
      <Text component="span" size="xs" c="dimmed">
        {scoreText}
      </Text>
    ) : undefined;

  return (
    <>
      <Box
        ref={isCurrentVariation ? targetRef : undefined}
        component="span"
        style={{
          display: tableLayout ? "block" : "inline-block",
          marginLeft: hasNumber ? 6 : 0,
          fontSize: "80%",
          width: tableLayout ? "100%" : undefined,
        }}
      >
        {hasNumber && `${moveNumber.toString()}${isWhite ? "." : "..."}`}
        {move &&
          (open ? (
            <Menu opened={open} width={200} onChange={setOpen}>
              <Menu.Target>
                <MoveCell
                  ref={ref}
                  move={move}
                  annotations={annotations}
                  isStart={isStart}
                  isCurrentVariation={isCurrentVariation}
                  onClick={onClick}
                  onContextMenu={onContextMenu}
                  fullWidth={tableLayout}
                  rightAccessory={rightAccessory}
                />
              </Menu.Target>

              <Portal>
                <MoveContextMenuItems movePath={movePath} />
              </Portal>
            </Menu>
          ) : (
            <MoveCell
              ref={ref}
              move={move}
              annotations={annotations}
              isStart={isStart}
              isCurrentVariation={isCurrentVariation}
              onClick={onClick}
              onContextMenu={onContextMenu}
              fullWidth={tableLayout}
              rightAccessory={rightAccessory}
            />
          ))}
        {transpositions.length > 0 && (
          <Tooltip label="Transposition">
            <ActionIcon size="xs" onClick={() => store.getState().goToMove(transpositions[0])}>
              <IconArrowsJoin size="0.875rem" />
            </ActionIcon>
          </Tooltip>
        )}
      </Box>
      {showComments && !tableLayout && comment && <Comment comment={comment} />}
    </>
  );
}

export default memo(CompleteMoveCell, (prev, next) => {
  return (
    prev.move === next.move &&
    prev.fen === next.fen &&
    prev.comment === next.comment &&
    equal(prev.annotations, next.annotations) &&
    prev.showComments === next.showComments &&
    prev.first === next.first &&
    equal(prev.movePath, next.movePath) &&
    prev.halfMoves === next.halfMoves &&
    prev.tableLayout === next.tableLayout &&
    prev.scoreText === next.scoreText
  );
});
