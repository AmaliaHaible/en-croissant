import { atom } from "jotai";
import useSWRImmutable from "swr/immutable";
import { commands, type HardwareInfo } from "@/bindings";

export const hardwareInfoAtom = atom(async (): Promise<HardwareInfo> => {
    try {
        return await commands.getHardwareInfo();
    } catch {
        return {
            cpuBrand: "Generic CPU",
            physicalCores: navigator.hardwareConcurrency || 4,
            logicalCores: navigator.hardwareConcurrency || 4,
            totalMemoryMb: 8192,
            availableMemoryMb: 4096,
            osName: "Unknown",
            osVersion: "",
            arch: "x86_64",
            isBmi2: false,
            isAvx2: false,
            recommendedThreads: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
            recommendedHashMb: 512,
        };
    }
});

export function useHardwareInfo() {
    const { data, error, isLoading } = useSWRImmutable("hardware_info", async () => {
        return await commands.getHardwareInfo();
    });

    return {
        hardware: data,
        isLoading,
        error,
    };
}
