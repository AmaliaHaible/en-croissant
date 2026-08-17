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

### Second-pass deferred loading

A second pass added lazy boundaries around the TipTap annotation editor and evaluation chart,
parallelized the four independent startup directory IPC requests, and avoided loading PostHog when
telemetry is disabled.

The initial HTML module graph remained effectively unchanged:

| Measurement                  | Before second pass | After second pass |             Change |
| ---------------------------- | -----------------: | ----------------: | -----------------: |
| Initial JavaScript, gzip     |         393.43 KiB |        394.38 KiB | +0.95 KiB (+0.24%) |
| Initial JavaScript, minified |       1,392.49 KiB |      1,393.70 KiB | +1.21 KiB (+0.09%) |

The small increase is code-splitting overhead and is not a meaningful initial-load improvement. The
benefit is finer-grained deferred loading after startup:

- The shared `routes` chunk decreased from 985.31 KiB to 501.73 KiB, a 49.1% reduction.
- The TipTap annotation editor moved into a separate 456.51 KiB on-demand chunk.
- The evaluation chart implementation moved into a separate 29.10 KiB on-demand chunk, with its
  chart dependencies split more granularly.
- The four independent directory IPC requests now run concurrently.
- PostHog is not loaded when telemetry is disabled.

This pass improves progressive loading of game panels rather than the application's initial HTML
preload. The frontend build completed in 4.16 seconds and the complete optimized Rust release build
completed in 1 minute 48 seconds, but single samples are not used to claim build-speed improvements.

### FIDE flag bundle reduction

`FideInfo` previously used a namespace import from `mantine-flagpack` and constructed a lookup from
every exported flag component, which caused the entire flag collection to be bundled. Replacing that
collection with a small ISO country-code-to-Unicode-flag conversion produced:

| Measurement               |    Before |    After |                  Change |
| ------------------------- | --------: | -------: | ----------------------: |
| `FideInfo` minified chunk | 850.70 kB | 61.80 kB | 788.91 kB (92.7%) lower |

Unlike splitting an existing chunk into additional on-demand chunks, this removes approximately
788.91 kB of minified JavaScript from the application bundle. The compressed after-size was not
recorded, so no gzip reduction is claimed here.

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

## Tauri runtime optimization pass

A subsequent Rust pass targeted algorithmic and runtime overhead in the application workflows that
the static audit identified. It made the following changes without altering the frontend command
API:

| Workflow           | Change                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player statistics  | Replaced repeated linear opening-table scans with a prebuilt hash lookup and removed the temporary position vector.                                                                                                  |
| Puzzle selection   | Replaced `ORDER BY RANDOM()` with a random primary-key pivot and wraparound, corrected the cache key to include the database path, and moved selection to the blocking task pool.                                    |
| Position search    | Replaced shared Rayon aggregation locks with worker-local accumulators, associated the mmap cache with its database path, made cache entries database-revision-aware, and capped the result cache.                   |
| PGN import         | Cached player, event, and site IDs and isolated bulk-import SQLite pragmas from the interactive connection pool.                                                                                                     |
| PGN files          | Reused valid in-memory game offsets, invalidated them after edits, and changed game replacement from two complete copies to one atomic replacement pass.                                                             |
| Engine integration | Reused parsed positions for UCI updates, capped retained logs, released DashMap guards before awaits, and initialized two game engines concurrently.                                                                 |
| IPC and utilities  | Suppressed clock events for games without clocks, refreshed only memory information for engine hash sizing, reused the HTTP client, throttled download progress, and moved archive extraction off the async runtime. |

### Tauri microbenchmarks

Benchmarks were run on Ubuntu 26.04 with Linux 7.0.0, an AMD Ryzen 7 9800X3D (8 cores/16 threads),
64 GiB RAM, and Rust 1.97.1. The before build is commit `cd74d7cd`, immediately before this Rust pass;
the after build is the current `performance-improvements` working tree. Both native binaries used the
Cargo release profile. Samples were run sequentially on the same machine with warm filesystem cache.

| Workflow                    | Input                                     | Runs | Before median | After median |        Result |
| --------------------------- | ----------------------------------------- | ---: | ------------: | -----------: | ------------: |
| Opening lookup              | Last entry in the 4,600-entry opening set |    5 |     295.63 ms |      5.91 ms |  50.1x faster |
| Import metadata resolution  | 10,000 repeats of four metadata lookups   |    5 |      44.78 ms |      0.34 ms | 132.2x faster |
| Unfiltered puzzle refill    | 1.18 GB Lichess puzzle database           |   20 |     197.23 ms |    129.37 ms |  34.4% faster |
| `short`-theme puzzle refill | 1.18 GB Lichess puzzle database           |   10 |     425.52 ms |    146.13 ms |  65.7% faster |
| PGN game replacement I/O    | 17.68 MiB active Chess.com PGN            |    7 |       7.01 ms |      2.74 ms |  60.9% faster |

The opening benchmark performs 100,000 lookups per sample using the actual release-compiled Rust
implementation. It intentionally selects the last opening to represent the worst case for the old
linear scan. The median fell from 2.956 microseconds to 59 nanoseconds per lookup. Run it with:

```bash
cargo test --release --manifest-path src-tauri/Cargo.toml benchmark_opening_lookup -- --ignored --nocapture
```

The import benchmark performs 10,000 repeated resolutions of two players, one event, and one site
against an in-memory SQLite database. It isolates the metadata-ID cache added to PGN import; PGN
parsing, game insertion, index creation, and disk throughput are deliberately excluded. Run it with:

```bash
cargo test --release --manifest-path src-tauri/Cargo.toml benchmark_repeated_import_metadata_lookup -- --ignored --nocapture
```

The puzzle benchmark selected 20 puzzles in the 1200–2200 rating range (3,012,561 matching rows).
The old `ORDER BY RANDOM()` query had a 198.17 ms p95; the primary-key pivot implementation had a
154.53 ms p95. Median CPU time fell from 197.22 ms to 129.29 ms. An intermediate random-offset
implementation was rejected after measurement because it regressed to roughly 7.7–8.1 seconds per
refill on this dataset. With the common `short` theme applied, median refill time fell from 425.52 ms
to 146.13 ms and median CPU time fell from 425.50 ms to 146.12 ms.

The PGN benchmark reproduced the old two-full-copy replacement and the new one-pass atomic
replacement on temporary copies. Its p95 fell from 7.80 ms to 2.74 ms. The original PGN and puzzle
database were opened read-only or copied before writes; application data was not modified.

### Startup and idle memory comparison

Five launches of each isolated release binary used fresh temporary `XDG_DATA_HOME` and
`XDG_CONFIG_HOME` directories. Startup ends at the existing `React app started successfully` log;
RSS is the summed process-group resident memory three seconds later.

| Measurement            | Before (`cd74d7cd`) |     After | Interpretation                                |
| ---------------------- | ------------------: | --------: | --------------------------------------------- |
| React-ready median     |            328.0 ms |  329.2 ms | No material change                            |
| React-ready p95        |            348.0 ms |  345.9 ms | No material change                            |
| Idle process-group RSS |           543.8 MiB | 549.5 MiB | 1.0% higher; within observed run-to-run noise |

The startup/RSS samples do not show an improvement. Process-group RSS can double-count shared WebKit
pages and varied by roughly 46 MiB between individual baseline runs, so the 5.7 MiB median difference
is not treated as a regression.

## Data processing and backend optimization pass

A subsequent pass introduced zero-allocation state algorithms, query deduplication, and backend memory allocator upgrades:

| Optimization | Scope | Change |
| ------------ | ----- | ------ |
| Tree Structure Hashing | TypeScript state (`treeReducer.ts`) | Replaced dynamic string-array allocations and template-string concatenation in `getTreeStructureHash` with an in-place 32-bit bitwise hash. |
| Repertoire Position Caching | TypeScript repertoire (`repertoire.ts`) | Cached in-flight and resolved position queries in `computeTreeCoverage` to eliminate duplicate IPC queries across opening transpositions. |
| Global Allocator | Rust backend (`main.rs`) | Replaced default system allocator with `mimalloc` to reduce thread contention and memory fragmentation in parallel Rayon and SQLite workloads. |
| SQLite Connection Pragmas | Rust backend (`db/mod.rs`) | Configured `PRAGMA synchronous = NORMAL`, `PRAGMA cache_size = -64000` (64MB), `PRAGMA temp_store = MEMORY`, and `PRAGMA mmap_size = 268435456` (256MB). |

### Data processing microbenchmarks

Tested on Linux 7.0.0, AMD Ryzen 7 9800X3D (8 cores / 16 threads), with Node.js 26 and Vitest:

| Benchmark | Input | Iterations | Before median | After median | Change |
| --------- | ----- | ---------: | ------------: | -----------: | -----: |
| `getTreeStructureHash` | 3,280-node repertoire tree | 500 | 177.76 µs/op (88.88 ms) | 131.40 µs/op (65.70 ms) | **26.1% faster** (0 heap string allocations) |

Run the benchmark with:
```bash
NODE_OPTIONS=--localstorage-file=/tmp/en-croissant-localstorage.json npx vitest run src/utils/tests/tree_hash.test.ts
```

## Validation

- `npm run build-vite`: passed (built in 4.17s).
- `NODE_OPTIONS=--localstorage-file=/tmp/en-croissant-localstorage.json npm test`: 6 test files, 42 tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with `mimalloc` global allocator and SQLite connection pragmas.

