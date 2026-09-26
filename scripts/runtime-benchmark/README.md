# Runtime comparison with exploring and painting users

## Production Node/Bun images on k3s

Issue [#390](https://github.com/mia-cx/Caelestis/issues/390) uses the same corrected 256-user trace against production images.
Import matching Node/Bun backend images and the Node frontend with `scripts/stack-tests/k3s-images.mjs` first.
Use an explicitly authorized test cluster with CNPG, Longhorn, Traefik, and a dedicated HTTPS hostname.

```sh
CAELESTIS_KUBE_CONTEXT=YOUR_CONTEXT CAELESTIS_TEST_ORIGIN=https://YOUR_TEST_HOST \
  CAELESTIS_TEST_NODE=YOUR_APPLICATION_NODE \
  CAELESTIS_TEST_EXTENDED=true CAELESTIS_TEST_STORAGE=s3 CAELESTIS_TEST_BENCHMARK=true \
  node scripts/test-helm-stack.mjs YOUR_BACKEND_IMAGE YOUR_FRONTEND_IMAGE cnpg
```

The driver creates a fresh namespace and storage, verifies pod replacement, CNPG switchover, TLS, and migrations,
then replays 179 explorers and 77 painters through Traefik HTTPS/WSS. It retains the 256-subscriber limit.
For a capacity ladder, set `CAELESTIS_TEST_BENCHMARK_USERS` to a larger trace and raise the backend's limit
to match through `CAELESTIS_TEST_BACKEND_ENV='[{"name":"CAELESTIS_LIVE_SUBSCRIBER_LIMIT","value":"2048"}]'`;
presence already allows 2,048 subscribers. Such runs measure capacity, not the production configuration.
Every successful run has 35 seconds of warmup and 60 measured seconds. For a passing comparison, repeat three times per runtime, alternating order.
Use identical application revisions, frontend images, fixtures, and pod placement. Record any shared-cluster noise.
This verifies load after recovery; the workload does not retry connections during a fault or represent a long soak test.
The [September 14 production-image report](../../docs/bun-runtime-validation-2026-09-14.md) records failures during warmup on both runtimes.
The [September 18 tile-processing report](../../docs/tile-processing-latency-2026-09-18.md) records both runtimes passing once the Postgres adapter's queries moved from one owned session to the fenced pool, with a capacity ladder on those images; `compact-report.mjs` turns a raw report into an entry of its results file.

Strict runs stop at the userscript's five-second command deadline. To investigate an existing timeout,
set `CAELESTIS_TEST_BENCHMARK_OBSERVE=true`. This diagnostic mode waits at most 30 seconds for replies,
counts every reply exceeding the original deadline, and marks the benchmark failed if any deadline is missed.
It can finish collecting resources and eventual correctness without claiming a production-capacity pass.
Observation mode exits successfully when collection completes; inspect `benchmark.json` and `result.json` for the pass/fail verdict.

`benchmark.json` records image IDs, pod placement, runtime versions, driver/source/trace/fixture hashes,
traffic correctness, latency, and resource measurements. Raw traces and samples remain beside it.
`result.backendStages` is the backend's own per-stage breakdown of uploads, offers, and paints
(queue wait, hashing, target lookup, reservation, blob PUT, decode, classification, commit,
projection, alarms, artifacts, history fold, total), read from `/admin/server/ingest-timings`
after the run. Counters record shared versus computed classifications and skipped blob PUTs.
The breakdown covers setup, warmup, and the measured phase together.
The backend and full application stack have separate CPU, cgroup RSS, and working-set results.
The latter includes the backend, frontend, two CNPG instances, and MinIO. It excludes shared Traefik,
operators, Longhorn engines, node services, and the load generator. Browser rendering and Wplace downloads remain outside the workload.

CPU is cumulative core time divided by elapsed time; 100% means one core.
The kubelet caches snapshots, so only counter timestamps inside the measured phase contribute.
Each container's actual CPU interval is recorded. Cached warmup data is excluded, and missing counters or restarts invalidate the comparison.
See Kubernetes' [node metrics documentation](https://kubernetes.io/docs/reference/instrumentation/node-metrics/).

The existing cleanup inventory removes the namespace, PVs, and Longhorn backing storage on success or failure.
Remove imported image references afterward with `k3s-images.mjs remove` and their recorded inventory.

## Historical local exploration

Tracks [#385](https://github.com/mia-cx/Caelestis/issues/385), with code and findings in PR #351.

Run from the repository root on Linux with Docker, cgroup v2 and `taskset` available:

```sh
pnpm --filter @caelestis/backend... build
NODE_BINARY=/absolute/path/to/node BUN_BINARY=/absolute/path/to/bun \
  BENCH_USERS=10 taskset -c 0,1 node scripts/runtime-benchmark/run.mjs
```

Repeat with `BENCH_USERS=100`, `BENCH_USERS=256` and `BENCH_USERS=1000`. The 256-user case uses 179 explorers and 77 painters, rounding the 70/30 split to whole users. It exercises the production admission limit without an override. Use the Node version pinned in the Dockerfile. The driver records both runtime versions, CPU affinity, application commit, benchmark source hashes, trace hash and fixture hashes. Override CPU assignments on machines with fewer than six available logical CPUs. `run.mjs` lists the available environment overrides.

Each successful user-count comparison takes about 15 minutes. Each of three repetitions rotates the order of Node, Bun with the existing Node adapter, and Bun with native HTTP/WebSockets. Each case gets a fresh PostgreSQL database, 35 seconds of warmup and 60 measured seconds. Warmup failures retain their partial measurements and phase. The load generator and database use different CPU cores from the backend. All cases use the same compiled application and fixtures.

Before measured sampling starts, the driver drains warmup paint and tile command chains, including requested uploads. It shifts the remaining trace by the boundary pause so measurement keeps its full duration without a catch-up burst. Coalesced notifications and periodic server work can still cross the boundary. Archived September 14 comparisons predate this fix and disclose unquantified warmup overlap in the report.

Seventy percent of users explore with moving and paused periods. Viewport messages follow the userscript's 300 ms throttle. Thirty percent publish one draft change per second, submit 30 pixels every 30 seconds, and nudge their small viewport every 12 seconds. Paint submissions and viewport nudges have independent, deterministic offsets. This assumes painters have stored charges available. These are synthetic human activity assumptions, not captured production traffic.

The fixture is the real 1612×2584 Box Art export at its original coordinates. Its eight canvas tiles use the artwork's palette, with small unfinished areas for the painters. Synthetic tile snapshots reflect completed paints at five-second intervals. Every user opens authenticated presence and live-sync sockets. Explorers offer observed tiles in template coverage; the server requests binary uploads when needed. Painters own persistent region claims. State-vector subscriptions receive real status changes.

Production limits live-sync subscribers to 256. At 1,000 users, the driver copies the compiled backend into its temporary directory and raises only that constant to 1,000. The recorded capacity field distinguishes this experiment from production admission. All runtimes receive the same override. The 2,048-presence-subscriber and 64-nearest-peer limits remain in effect. Source files and the original build stay unchanged.

The benchmark asserts successful tile delivery, exact persisted paint totals, duplicate paint rejection, the requested online count, and each recipient's final nearest-peer set, viewports and draft pixels. Server-side draft quantization preserves logical pixels and is checked after decoding masks. Commands use the userscript's five-second deadline. The run stops at the first failed command or correctness check and records the failure; it does not simulate retries or HTTP fallback after overload.

`results.json` contains per-run backend and driver CPU, sampled resident memory, latency distributions, traffic counts and correctness results. Separate sample files preserve raw latency, 20 ms event-loop timer delay and 250 ms memory samples. The driver records dispatch lateness to expose an overloaded load generator. Viewport latency measures changed states delivered to recipients who already track that peer; entering an interest area does not count as delayed delivery. Intentional server coalescing means this metric is not an acknowledgement for every input update. Failed runs contain censored latency samples and must not be ranked as successful low-latency runs.

This measures the backend with local PostgreSQL and filesystem objects. It excludes S3, TLS, Traefik, browser rendering, Wplace tile downloads, and long-running recovery or failover. PostgreSQL CPU is measured separately. Native Bun uses a benchmark-only socket bridge into the production host, retaining application queues and coordinators. It is not a supported deployment adapter or an exhaustive Bun compatibility test.

The driver removes its own temporary backend files, PostgreSQL container and anonymous volume on completion or failure. It leaves logs and measurements under `test-results/runtime-benchmark/`. It never accesses the retained k3s laptop stack.

`BENCH_CPU_PROFILE=1 BENCH_VARIANTS=node` enables a diagnostic Node CPU profile. Profiling runs are marked in the result and excluded from performance comparisons.

For the production Workers implementation, run `BENCH_VARIANTS=miniflare BENCH_USERS=256` with the same command. This uses Miniflare/workerd from the installed Wrangler dependency, bundles the Worker, and creates ephemeral local D1, R2 and SQLite-backed Durable Objects. It makes no Cloudflare network calls and starts no PostgreSQL container. All five application Durable Object bindings remain enabled. The subscriber limit stays unchanged.

Miniflare runs separately from the Node/Bun repetitions because its storage and metric scope differ. CPU and RSS include both workerd and its Node controller, with per-process breakdowns. Local D1/R2/DO emulation is inside that scope; PostgreSQL in the Node/Bun results is separate. Summed process RSS can double-count shared pages. Workerd CPU comes from Linux process ticks; the controller uses `process.cpuUsage()`. The parent controller's event loop would not represent Worker or DO latency, so Miniflare reports no event-loop samples. Network traffic and the correctness checks use the same driver and trace. Treat this as a local runtime-and-adapter comparison, not an isolated engine benchmark or Cloudflare production forecast.
