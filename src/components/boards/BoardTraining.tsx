import { Paper, Portal, Stack, Text } from "@mantine/core";
import { useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";

function BoardTraining({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  // Touch the store so the provider stays engaged like the other board views.
  useStore(store, (s) => s.root.fen);
  const boardRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board editingMode={false} boardRef={boardRef} movable="turn" disableVariations />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <Paper h="100%" withBorder p="md">
          <Stack>
            <Text fw={600}>{t("Board.Training.Setup.Title", "Training setup")}</Text>
            <Text c="dimmed" fz="sm">
              tab {id}
            </Text>
          </Stack>
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <GameNotation />
          <MoveControls readOnly />
        </Stack>
      </Portal>
    </>
  );
}

export default BoardTraining;
