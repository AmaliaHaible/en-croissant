import { BaseDirectory, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { warn } from "@tauri-apps/plugin-log";
import equal from "fast-deep-equal";
import { compressToUTF16, decompressFromUTF16 } from "lz-string";
import type {
    AsyncStorage,
    AsyncStringStorage,
    SyncStorage,
    SyncStringStorage,
} from "jotai/vanilla/utils/atomWithStorage";
import type { z } from "zod";

const options = { baseDir: BaseDirectory.AppData };
export const fileStorage: AsyncStringStorage = {
    async getItem(key) {
        try {
            return await readTextFile(key, options);
        } catch (error) {
            return null;
        }
    },
    async setItem(key, newValue) {
        await writeTextFile(key, newValue, options);
    },
    async removeItem(key) {
        await remove(key, options);
    },
};

// Prefix stamped on every value written through `compressedStringStorage`, so a
// value stored before compression existed (plain JSON, no marker) is recognised
// and returned untouched instead of being fed to the decompressor. JSON written
// by `createZodStorage` always starts with `{`/`[`/`"`, never this prefix.
const COMPRESSION_MARKER = "lz1:";

/**
 * Wraps a string storage so values are LZ-compressed going in and decompressed
 * coming out. Repertoire practice decks — one FSRS card per repertoire position
 * plus a review log — outgrow the ~5 MB `localStorage` quota on large
 * repertoires and the failing `setItem` used to tear down the whole tab.
 * Compression buys roughly a 10x headroom. Legacy uncompressed values are read
 * back verbatim and re-compressed on the next write.
 */
export function compressedStringStorage(inner: SyncStringStorage): SyncStringStorage {
    return {
        getItem(key) {
            const raw = inner.getItem(key);
            if (raw === null) {
                return null;
            }
            if (!raw.startsWith(COMPRESSION_MARKER)) {
                return raw; // written before compression — plain JSON
            }
            // `decompressFromUTF16` returns null for a corrupt payload; treat
            // that as a missing key so the atom falls back to its initial value.
            return decompressFromUTF16(raw.slice(COMPRESSION_MARKER.length));
        },
        setItem(key, newValue) {
            inner.setItem(key, COMPRESSION_MARKER + compressToUTF16(newValue));
        },
        removeItem(key) {
            inner.removeItem(key);
        },
        subscribe: inner.subscribe?.bind(inner),
    };
}

export function createZodStorage<Value>(
    schema: z.ZodType<Value>,
    storage: SyncStringStorage,
): SyncStorage<Value> {
    return {
        getItem(key, initialValue) {
            const storedValue = storage.getItem(key);
            if (storedValue === null) {
                return initialValue;
            }
            try {
                const rawValue = JSON.parse(storedValue);
                const parsedValue = schema.parse(rawValue);
                if (!equal(rawValue, parsedValue)) {
                    this.setItem(key, parsedValue);
                }
                return parsedValue;
            } catch {
                warn(`Invalid value for ${key}: ${storedValue}`);
                this.setItem(key, initialValue);
                return initialValue;
            }
        },
        setItem(key, value) {
            try {
                storage.setItem(key, JSON.stringify(value));
            } catch (error) {
                // A failed persist (most often `QuotaExceededError` from a full
                // `localStorage`) is thrown synchronously out of a Jotai write.
                // Swallow it and degrade to in-memory-only for this key rather
                // than let it unwind through React's commit phase.
                warn(`Failed to persist ${key}: ${error}`);
            }
        },
        removeItem(key) {
            storage.removeItem(key);
        },
    };
}

export function createAsyncZodStorage<Input, Output>(
    schema: z.ZodType<Output, z.ZodTypeDef, Input>,
    storage: AsyncStringStorage,
): AsyncStorage<Output> {
    return {
        async getItem(key, initialValue) {
            try {
                const storedValue = await storage.getItem(key);
                if (storedValue === null) {
                    return initialValue;
                }
                const rawValue = JSON.parse(storedValue);
                const res = schema.safeParse(rawValue);
                if (res.success) {
                    if (!equal(rawValue, res.data)) {
                        await this.setItem(key, res.data);
                    }
                    return res.data;
                }
                warn(`Invalid value for ${key}: ${storedValue}\n${res.error}`);
                await this.setItem(key, initialValue);
                return initialValue;
            } catch (error) {
                warn(`Error getting ${key}: ${error}`);
                return initialValue;
            }
        },
        async setItem(key, value) {
            storage.setItem(key, JSON.stringify(value, null, 4));
        },
        async removeItem(key) {
            storage.removeItem(key);
        },
    };
}
