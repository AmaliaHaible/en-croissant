import { ActionIcon, Group } from "@mantine/core";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { memo, useContext } from "react";
import { useStore } from "zustand";
import { useKeybind } from "@/hooks/useKeybind";
import { keyMapAtom } from "@/state/keybinds";
import { TreeStateContext } from "./TreeStateContext";

function MoveControls({ readOnly }: { readOnly?: boolean }) {
  const store = useContext(TreeStateContext)!;
  const next = useStore(store, (s) => s.goToNext);
  const previous = useStore(store, (s) => s.goToPrevious);
  const start = useStore(store, (s) => s.goToStart);
  const end = useStore(store, (s) => s.goToEnd);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const startBranch = useStore(store, (s) => s.goToBranchStart);
  const endBranch = useStore(store, (s) => s.goToBranchEnd);
  const nextBranch = useStore(store, (s) => s.nextBranch);
  const previousBranch = useStore(store, (s) => s.previousBranch);
  const nextBranching = useStore(store, (s) => s.nextBranching);
  const previousBranching = useStore(store, (s) => s.previousBranching);

  const keyMap = useAtomValue(keyMapAtom);
  useKeybind(keyMap.PREVIOUS_MOVE.keys, previous);
  useKeybind(keyMap.NEXT_MOVE.keys, next);
  useKeybind(keyMap.GO_TO_START.keys, start);
  useKeybind(keyMap.GO_TO_END.keys, end);
  useKeybind(keyMap.DELETE_MOVE.keys, readOnly ? () => {} : () => deleteMove());
  useKeybind(keyMap.GO_TO_BRANCH_START.keys, startBranch);
  useKeybind(keyMap.GO_TO_BRANCH_END.keys, endBranch);
  useKeybind(keyMap.NEXT_BRANCH.keys, nextBranch);
  useKeybind(keyMap.PREVIOUS_BRANCH.keys, previousBranch);
  useKeybind(keyMap.NEXT_BRANCHING.keys, nextBranching);
  useKeybind(keyMap.PREVIOUS_BRANCHING.keys, previousBranching);

  return (
    <Group grow gap="xs">
      <ActionIcon variant="default" size="lg" onClick={start}>
        <IconChevronsLeft />
      </ActionIcon>
      <ActionIcon variant="default" size="lg" onClick={previous}>
        <IconChevronLeft />
      </ActionIcon>
      <ActionIcon variant="default" size="lg" onClick={next}>
        <IconChevronRight />
      </ActionIcon>
      <ActionIcon variant="default" size="lg" onClick={end}>
        <IconChevronsRight />
      </ActionIcon>
    </Group>
  );
}

export default memo(MoveControls);
