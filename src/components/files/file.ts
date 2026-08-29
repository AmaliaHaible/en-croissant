import { BaseDirectory, basename, join } from "@tauri-apps/api/path";
import { type DirEntry, exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { z } from "zod";
import { commands } from "@/bindings";
import { unwrap } from "@/utils/unwrap";

const fileTypeSchema = z.enum(["repertoire", "game", "tournament", "puzzle", "other"]);

export type FileType = z.infer<typeof fileTypeSchema>;

const fileInfoMetadataSchema = z.object({
    type: fileTypeSchema,
    tags: z.array(z.string()),
    displayName: z.string(),
    createdAt: z.number(),
});

export type FileInfoMetadata = z.infer<typeof fileInfoMetadataSchema>;

export const fileMetadataSchema = z.object({
    type: z.literal("file"),
    name: z.string(),
    path: z.string(),
    numGames: z.number(),
    metadata: fileInfoMetadataSchema,
    lastModified: z.number(),
});

export type FileMetadata = z.infer<typeof fileMetadataSchema>;

export type FileData = {
    metadata: FileInfoMetadata;
    games: string[];
};

export function normalizeFileInfoMetadata(
    raw: Partial<FileInfoMetadata> | null | undefined,
    fallback: { displayName: string; createdAt: number },
): FileInfoMetadata {
    return {
        type: raw?.type ?? "other",
        tags: raw?.tags ?? [],
        displayName: raw?.displayName ?? fallback.displayName,
        createdAt: raw?.createdAt ?? fallback.createdAt,
    };
}

export function getDisplayName(file: Pick<FileMetadata, "name" | "metadata">): string {
    return file.metadata.displayName || file.name;
}

/** Extracts a non-empty `displayName` from the raw contents of a `.info` file, or null. */
export function parseInfoDisplayName(rawJson: string): string | null {
    try {
        const displayName = (JSON.parse(rawJson) as Partial<FileInfoMetadata> | null)?.displayName;
        return typeof displayName === "string" && displayName.length > 0 ? displayName : null;
    } catch {
        return null;
    }
}

/** Reads the pretty display name stored alongside a `.pgn` in its `.info` file, or null. */
export async function readInfoDisplayName(path: string): Promise<string | null> {
    if (!path.endsWith(".pgn")) {
        return null;
    }
    const metadataPath = path.replace(".pgn", ".info");
    if (!(await exists(metadataPath))) {
        return null;
    }
    return parseInfoDisplayName(await readTextFile(metadataPath));
}

export function getEntryDisplayName(entry: FileMetadata | Directory): string {
    return entry.type === "file" ? getDisplayName(entry) : entry.name;
}

async function readFileMetadata(path: string): Promise<FileMetadata | null> {
    if (!path.endsWith(".pgn")) {
        return null;
    }
    const metadataPath = path.replace(".pgn", ".info");
    const name = (await basename(path)).replace(".pgn", "");
    const fileMetadata = unwrap(await commands.getFileMetadata(path));

    let rawMetadata: Partial<FileInfoMetadata> | null = null;
    if (await exists(metadataPath)) {
        rawMetadata = JSON.parse(await readTextFile(metadataPath));
    }
    const metadata = normalizeFileInfoMetadata(rawMetadata, {
        displayName: name,
        createdAt: fileMetadata.last_modified * 1000,
    });
    if (
        !rawMetadata ||
        rawMetadata.displayName === undefined ||
        rawMetadata.createdAt === undefined
    ) {
        await writeTextFile(metadataPath, JSON.stringify(metadata));
    }

    const numGames = unwrap(await commands.countPgnGames(path));
    return {
        type: "file",
        path,
        name,
        numGames,
        metadata,
        lastModified: fileMetadata.last_modified,
    };
}

export type Directory = {
    type: "directory";
    children: (FileMetadata | Directory)[];
    path: string;
    name: string;
};

export async function processEntriesRecursively(parent: string, entries: DirEntry[]) {
    const processedEntries = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isFile) {
                return await readFileMetadata(await join(parent, entry.name));
            }
            if (entry.isDirectory) {
                const dir = await join(parent, entry.name);
                const newEntries = await processEntriesRecursively(
                    dir,
                    await readDir(dir, { baseDir: BaseDirectory.AppLocalData }),
                );
                const directory: Directory = {
                    type: "directory",
                    name: entry.name,
                    path: dir,
                    children: newEntries,
                };
                return directory;
            }
            return null;
        }),
    );

    return processedEntries.filter((entry): entry is FileMetadata | Directory => entry !== null);
}
