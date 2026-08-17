# TypeScript 7 Migration Benchmark

Date: 2026-08-17

This benchmark compares the TypeScript 7 native preview previously used by En Croissant with
stable TypeScript 7. It was recorded while migrating the project on branch
`migrate-stable-typescript-7` from commit `9654961d62d023b328591a609431570b7d94aa52`.

## Versions

| Variant | Package                      | Compiler version       | Command         |
| ------- | ---------------------------- | ---------------------- | --------------- |
| Preview | `@typescript/native-preview` | `7.0.0-dev.20260306.1` | `tsgo --noEmit` |
| Stable  | `typescript`                 | `7.0.2`                | `tsc --noEmit`  |

Both variants used Vite 8.0.0 for the full frontend build.

## Environment

- Linux 7.0.0-29-generic, x86-64
- AMD Ryzen 7 9800X3D, 8 cores / 16 threads
- Node.js 26.5.1
- pnpm 10.34.5

## Method

The type-check comparison used five measured runs per compiler:

```sh
/usr/bin/time -f '%e,%U,%S,%M,%x' <compiler> --noEmit
```

The full frontend comparison used three warmed measured runs per variant:

```sh
/usr/bin/time -f '%e,%U,%S,%M,%x' pnpm build-vite
```

Wall time is the median of the measured runs. CPU utilization is aggregate user plus system CPU
time divided by aggregate wall time, so it can exceed 100% when multiple cores are used. Peak RSS
is the highest resident-memory measurement observed across the runs.

## Results

| Measurement                     | TS7 preview | TS7 stable |                       Change |
| ------------------------------- | ----------: | ---------: | ---------------------------: |
| Type-check median wall time     |     0.120 s |    0.110 s |                  8.3% faster |
| Type-check mean wall time       |     0.122 s |    0.112 s |                  8.2% faster |
| Type-check aggregate CPU        |      737.7% |     657.1% | 80.6 percentage points lower |
| Type-check peak RSS             |   338.7 MiB |  270.3 MiB |                  20.2% lower |
| Frontend-build median wall time |     5.720 s |    5.720 s |           No measured change |
| Frontend-build mean wall time   |     5.737 s |    5.727 s |                  0.2% faster |
| Frontend-build aggregate CPU    |      175.1% |     174.0% |  1.1 percentage points lower |
| Frontend-build peak RSS         |  1463.8 MiB | 1559.0 MiB |                  6.5% higher |

Stable TypeScript 7 type-checking was approximately 8% faster and used 20% less peak resident
memory in this sample. End-to-end frontend build time was unchanged because the Vite portion
dominates the build. The full-build peak-RSS difference should be treated as noise until confirmed
with a larger sample.

## Raw samples

The columns are run, wall seconds, user CPU seconds, system CPU seconds, peak RSS in KiB, and exit
status.

```text
Preview type-check
1,0.12,0.69,0.20,346836,0
2,0.13,0.74,0.22,338508,0
3,0.12,0.71,0.17,337876,0
4,0.12,0.69,0.19,341652,0
5,0.12,0.68,0.21,336724,0

Stable type-check
1,0.11,0.57,0.15,275556,0
2,0.11,0.56,0.17,276836,0
3,0.12,0.57,0.15,269924,0
4,0.11,0.53,0.20,275812,0
5,0.11,0.60,0.18,270308,0

Preview frontend build
1,5.70,9.45,0.60,1498904,0
2,5.79,9.45,0.61,1429032,0
3,5.72,9.37,0.66,1463152,0

Stable frontend build
1,5.70,9.25,0.57,1490180,0
2,5.76,9.47,0.60,1506196,0
3,5.72,9.35,0.65,1596404,0
```

## Validation

- Both variants completed type-checking and production frontend builds successfully.
- Both builds produced the same asset filenames and reported sizes.
- Stable TypeScript 7 linting completed with zero errors and 52 warnings.
- Vitest reported 18 passing tests and one failed suite because `localStorage` was unavailable
  under Node.js 26; this is separate from TypeScript compilation.
