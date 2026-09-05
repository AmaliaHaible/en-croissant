import { Box, Text } from "@mantine/core";
import type { Color, Square } from "chessops";
import type { Score } from "@/bindings";
import { squareToCoordinates } from "@/utils/chessops";
import { formatScore } from "@/utils/score";

export default function EvalPreviewBadge({
  square,
  score,
  orientation,
}: {
  square: Square;
  score: Score;
  orientation: Color;
}) {
  const { file, rank } = squareToCoordinates(square, orientation);
  const positive = score.value.value >= 0;

  return (
    <Box
      style={{
        position: "absolute",
        pointerEvents: "none",
        width: "12.5%",
        height: "12.5%",
        left: `${(file - 1) * 12.5}%`,
        bottom: `${(rank - 1) * 12.5}%`,
        zIndex: 100,
      }}
    >
      <Box
        style={(theme) => ({
          position: "absolute",
          top: "-0.3rem",
          left: "50%",
          transform: "translate(-50%, -100%)",
          backgroundColor: positive ? theme.colors.gray[0] : theme.colors.dark[9],
          borderRadius: theme.radius.sm,
          boxShadow: theme.shadows.md,
          padding: "0.1rem 0.35rem",
          whiteSpace: "nowrap",
        })}
      >
        <Text
          fz="xs"
          fw={700}
          c={positive ? "black" : "white"}
          style={(theme) => ({ fontFamily: theme.fontFamilyMonospace })}
        >
          {formatScore(score.value)}
        </Text>
      </Box>
    </Box>
  );
}
