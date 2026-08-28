import dayjs from "dayjs";
import type { GoMode } from "@/bindings";

function formatGoMode(goMode: GoMode): string | null {
    switch (goMode.t) {
        case "Depth":
            return `depth ${goMode.c}`;
        case "Time":
            return `${goMode.c}ms per move`;
        case "Nodes":
            return `${goMode.c} nodes`;
        default:
            return null;
    }
}

export function buildAnalysisLabel(
    engineName: string,
    goMode: GoMode,
    date: Date = new Date(),
): string {
    const goModeLabel = formatGoMode(goMode);
    const dateLabel = dayjs(date).format("YYYY-MM-DD");
    return goModeLabel
        ? `${engineName}, ${goModeLabel} — ${dateLabel}`
        : `${engineName} — ${dateLabel}`;
}
