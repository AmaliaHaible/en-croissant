import { resolve } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";

export type CollectionCategory =
    | "player-vs-engine"
    | "player-vs-player"
    | "engine-vs-engine"
    | "imported";

export const COLLECTION_FOLDER_NAMES: Record<CollectionCategory, string> = {
    "player-vs-engine": "Player vs Engine",
    "player-vs-player": "Player vs Player",
    "engine-vs-engine": "Engine vs Engine",
    imported: "Imported",
};

export async function getCollectionDir(
    documentDir: string,
    category: CollectionCategory,
): Promise<string> {
    const dir = await resolve(documentDir, COLLECTION_FOLDER_NAMES[category]);
    if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true });
    }
    return dir;
}

export async function ensureCollectionFolders(documentDir: string): Promise<void> {
    await Promise.all(
        (Object.keys(COLLECTION_FOLDER_NAMES) as CollectionCategory[]).map((category) =>
            getCollectionDir(documentDir, category),
        ),
    );
}

export function classifyPlayers(
    whiteType: "human" | "engine",
    blackType: "human" | "engine",
): CollectionCategory {
    if (whiteType === "engine" && blackType === "engine") {
        return "engine-vs-engine";
    }
    if (whiteType === "human" && blackType === "human") {
        return "player-vs-player";
    }
    return "player-vs-engine";
}
