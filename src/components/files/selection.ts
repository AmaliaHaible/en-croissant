type Entry =
    | { type: "file"; path: string }
    | { type: "directory"; path: string; children: Entry[] };

export function flattenVisibleEntries(
    files: Entry[],
    isExpanded: (path: string) => boolean,
): string[] {
    const result: string[] = [];
    for (const entry of files) {
        result.push(entry.path);
        if (entry.type === "directory" && isExpanded(entry.path)) {
            result.push(...flattenVisibleEntries(entry.children, isExpanded));
        }
    }
    return result;
}

export function computeRangeSelection(order: string[], anchor: string, target: string): string[] {
    const anchorIndex = order.indexOf(anchor);
    const targetIndex = order.indexOf(target);
    if (anchorIndex === -1 || targetIndex === -1) {
        return [target];
    }
    const [start, end] =
        anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    return order.slice(start, end + 1);
}
