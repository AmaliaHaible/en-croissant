# Performance Improvements

Date: 2026-08-17

This report records measurements from branch `performance-improvements` on Ubuntu 26.04 using a
release Tauri build. Values are local samples and should be compared on the same machine when the
work is repeated.

## Changes

- Enabled TanStack Router automatic route code splitting.
- Replaced an accidental `@tiptap/react` import in the score utility with a local numeric clamp.
- Deferred loading PostHog until after the React application has started.
- Enabled release LTO, single-codegen-unit optimization, panic aborts, and symbol stripping for the
  Rust binary.

## Frontend bundle

| Measurement                  |       Before |        After |      Change |
| ---------------------------- | -----------: | -----------: | ----------: |
| Initial JavaScript, gzip     | 1,403.03 KiB |   405.80 KiB | 71.1% lower |
| Initial JavaScript, minified | 4,656.47 KiB | 1,425.88 KiB | 69.4% lower |
| Initial CSS, gzip            |    43.87 KiB |    39.95 KiB |  8.9% lower |

The after value includes the entry module and every module-preload referenced by `dist/index.html`.
Route-specific code remains in on-demand chunks, so total application JavaScript is not expected to
fall by the same amount.

## Rust release binary

| Measurement |               Before |    After |                  Change |
| ----------- | -------------------: | -------: | ----------------------: |
| Binary size | approximately 46 MiB | 23.9 MiB | approximately 48% lower |
| Symbols     |         not stripped | stripped |                       — |

The first optimized release rebuild took 149 seconds because the profile change invalidated the
release dependency graph. Development and test profiles are unaffected. LTO can improve runtime
optimization across crate boundaries, but no CPU-heavy application workflow was benchmarked, so no
runtime-speed claim is made here.

## Startup and idle memory

Three valid optimized-build samples produced:

| Run    | React-ready time |  Idle process-group RSS |
| ------ | ---------------: | ----------------------: |
| 1      |           370 ms |             593,440 KiB |
| 2      |           370 ms |             589,368 KiB |
| 3      |           370 ms |             594,356 KiB |
| Median |           370 ms | 593,440 KiB (579.5 MiB) |

React-ready time is measured from process launch until the existing
`React app started successfully` log message. Idle RSS is the sum of the Tauri process and its WebKit
network and web processes after three seconds. Summed RSS can double-count shared pages and is best
used only for same-method comparisons. There is no pre-change startup/RSS sample, so these values are
a baseline rather than evidence of improvement.

## React and IPC audit

The project already enables React Compiler. No speculative `memo` or callback changes were added
without React Profiler traces. The current lint run reports 52 existing warnings, including unstable
hook dependencies that are useful candidates for a separate correctness and render-profiling pass.

Tauri progress, engine, clock, and database-search updates are event-driven. `useProgress` performs
one initial command invocation and then listens for events; no recurring frontend-to-Rust polling loop
was found to consolidate. CPU-heavy PGN, database, chess-engine, and file operations already live in
Rust, so moving arbitrary TypeScript code across the IPC boundary is not justified by this audit.

## Validation

- `npm run build-vite`: passed.
- `npm run lint`: passed with zero errors and 52 existing warnings.
- `NODE_OPTIONS=--localstorage-file=/tmp/en-croissant-localstorage.json npm test`: 40 tests passed.
- `npm run build`: complete Tauri release build passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 27 passed and 8 unrelated existing assertions
  failed in chess evaluation and database search tests.
