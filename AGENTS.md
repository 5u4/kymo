# kymo

## Stage

Single operator: the operator is the only one running kymo, so no database needs to survive a schema
change. Change the schema by editing the first migration (`0001`) in place; the operator deletes
`~/.kymo` when a change needs it. APIs and in-memory types change in place too: migrate every caller
and delete the old path in the same change, with no compatibility shims.

## Layout

- The repo root is the package `kymo`. It exports `src/*.ts` as `kymo/<module>` (`kymo/root`,
  `kymo/workflows`; `*.test.ts` modules are not exported) and `plugins/gh-cli/src` as `kymo/gh-cli`
  and `kymo/gh-cli/<module>`; `effect` is a peer dependency pinned to `4.1.2`.
- `apps/daemon` and `apps/cli` are plain directories of the root package, whose `dependencies` hold
  their runtime packages at literal versions, because a git install of kymo cannot resolve `catalog:`.
  The package's `bin.kymo` is `apps/cli/src/main.ts`. `apps/web` is the only workspace and depends
  on `"kymo": "workspace:*"`. Import shared modules as `kymo/<module>`, not by relative path into
  `src/`. `prepare` installs the lefthook hooks and patches TypeScript only in a git checkout (where
  `.git` is a directory or, in a worktree, a file); elsewhere, such as a `bun add -g` of kymo, it
  does nothing.
- The daemon (`apps/daemon/src/server.ts`) serves `apps/web/dist` to GET requests at every path
  outside `/api`, falling back to `index.html` for an extensionless path whose `Accept` includes
  `text/html`, and answers 404 to an unknown path under `/api/`. When `apps/web/dist` is missing,
  the API still works and pages answer 404.
- The CLI never imports daemon code. It spawns `apps/daemon/src/main.ts --root <dir>`, reads the
  root's files, signals the daemon's pid, and calls the daemon through the HttpApi in `kymo/api`.
  The daemon answers 403 to any request whose `Origin` header is present and is not the origin of
  `http://127.0.0.1:<port>` or `http://localhost:<port>` (the bound port, omitted when it is 80), so
  a page from another origin cannot start or change executions. It also answers 403 when the `Host`
  header is missing or is not the host of one of those URLs, so a page that rebinds its own domain
  to 127.0.0.1 cannot read them either. Both rules cover the UI's static files too.
  `apps/cli/src/main.ts` registers each command as `Lifecycle` (`start`, `stop`, `restart`) or
  `Daemon` (bare `kymo`, `executions`, `execution`, `execute`, `complete`, `resume`, `interrupt`);
  add every new command as `Daemon`, which fails with the same "not running" error while no daemon
  answers. A command declares its positionals and flags (`apps/cli/src/command.ts`); the parser
  rejects undeclared ones with exit 2, and the command decodes them with `Schema`.
- A root (`--root`, default `~/.kymo`) holds `kymo.json`, `kymo.db`, `daemon.log` (the daemon's
  stdout and stderr when the CLI starts it), `owner/` and `daemon.json`. A daemon claims the root
  with a symlink in `owner/` (`kymo/ownership`) before it opens `kymo.db`, so two daemons never
  share one database, writes `daemon.json` (its process identity and bound port) once its server
  listens, and removes its claim and `daemon.json` on SIGTERM or SIGINT. A process identity
  (`kymo/process-identity`) is a pid with the start time `ps` reports, so a pid reused by another
  process never counts as the daemon; claims and `daemon.json` record one, and the CLI signals only
  a process whose identity still matches. The CLI derives `Running` or `Stopped` from
  `daemon.json`, that identity's liveness and `GET /api/health` on every run; `kymo stop` also ends
  a daemon that still owns the root but does not answer.
- `plugins/*` and `examples/*` are plain directories inside the root package. `plugins/gh-cli` is a
  workflow source that ships with kymo; `examples/demo` is the reference workflow source.
- A workflow source is a module that default-exports a Layer `satisfies Workflows` (from
  `kymo/workflows`). `RootConfig.workflows` (the `workflows` array of `kymo.json`) lists the
  sources. `apps/daemon/src/workflow-sources.ts` imports and builds them, providing
  `WorkflowEngine`, `ChildProcessSpawner`, `FileSystem` and `Path`. Once that module is loaded, any
  `effect` or `kymo` file the process loads from a `node_modules` directory other than the daemon's
  own is replaced by the daemon's copy. Before it imports a path source, it fails startup if the
  source's directory resolves a `kymo` whose exported `.ts` files differ in content from the
  daemon's, or an `effect` with another version.
- Effect's `cluster_messages` and `cluster_replies` in `kymo.db` hold each execution's state;
  `apps/daemon/src/executions.ts` reads them and derives each execution's status in one function,
  `executionStatus`. kymo's own tables hold only what Effect does not: `kymo_labels` maps an
  execution id to the label `kymo execute --label` gave it, and `kymo_logs` holds the log lines at
  `Info` or above written in a workflow's body and activities. `apps/daemon/src/migrations.ts`
  creates them through `SqliteMigrator`, recording applied migrations in `kymo_migrations`, before the
  engine starts. The migrator skips every migration whose id is at or below the highest recorded id,
  so the daemon also compares the `kymo_*` definitions in `kymo.db` with those the same migrations
  create in an empty database. When they differ, startup fails with `SchemaOutdated`, which tells the
  operator to delete `kymo.db` and its `-wal` and `-shm` files. On startup the daemon resumes
  every suspended execution except one suspended by a failure, because resuming that one runs its
  body again.
- `apps/daemon/src/workflow-logs.ts` replaces the engine's loggers: a log from a fiber that has a
  `WorkflowInstance` goes only to `kymo_logs`; every other log goes to stdout, which the CLI appends
  to `daemon.log`. Each line records its body pass, because a replay runs the body again and repeats
  its log lines. Passes count from 1; after a restart they continue from the highest pass that stored
  a line. Activity lines record the name of the activity they run in and its attempt, and a replay
  does not repeat them because a completed activity does not run again. `kymo execution <id>
  --logs` shows them.
- File names are kebab-case; `bun run lint` enforces it.
- Nothing outside `design/` imports from `design/`.

## Reference

- `design/prototype/g-fusion.html` is the UI reference. Serve it with the paseo `prototype` script
  or `cd design/prototype && python3 -m http.server <port>`.

## Web

- `useEffect`, `useLayoutEffect` and `useInsertionEffect` are banned by `bun run lint`. Derive during
  render or use an event handler; `useMountEffect` in `apps/web/src/use-mount-effect.ts` is the only
  escape.
- The URL holds navigable UI state, through TanStack Router search params. `apps/web/src/main.tsx`
  parses every search value as a string and drops empty ones, so `?q=123` and `?exec=1` stay
  strings and `?exec=` selects nothing.
- The `/` route loads `GET /api/health`, `GET /api/workflows` and the whole unfiltered
  `GET /api/executions`, plus `GET /api/executions/:id` and the last 500 lines of
  `GET /api/executions/:id/logs` when `?exec=<id or prefix>` selects an execution, reloads them
  every 2 seconds, and filters during render in `apps/web/src/executions-view.ts`. A 404 or 409
  from the detail or logs request shows in the detail pane, not as the daemon being down. The trace
  is derived from the detail and the list in `apps/web/src/trace-view.ts`, and each span's logs in
  `apps/web/src/log-view.ts`, whose counts come from the response's `counts` because those cover
  every line, not only the fetched ones; the selected span, expanded rows, zoom, split height,
  inspector tab and log level filter stay in component state.
- The detail pane offers the actions `actionsFor` allows plus completing an open Deferred wait. It
  POSTs them through `apps/web/src/actions.ts` and then reloads the route. Each POST answers with
  the execution as it was before the action, and the status name can stay the same across one (a
  resume that fails again, a completed wait followed by the next), so the pane keeps every action
  disabled until the detail's `updatedAt` differs from the one the POST returned, or until 10
  seconds after the POST answered. An action's error shows in the pane, never as the daemon being
  down.
- Every `kymo` command the UI shows while the daemon answers goes through `kymoCommand`
  (`kymo/shell`), which the CLI uses too. It adds `--root` unless `GET /api/health` reports
  `defaultRoot` (the daemon's root is its own `$HOME/.kymo`), so a copied command run under the same
  `HOME` acts on the daemon's root. The daemon-down screen has no root to read and shows plain
  `kymo` and `kymo start`.
- `bun run --cwd apps/web dev` proxies `/api` to `KYMO_DAEMON` (default `http://127.0.0.1:4419`),
  rewriting `Host` and dropping `Origin` only when it is the dev server's own origin, so the daemon
  accepts the UI's requests and still answers 403 to a page from another origin.

## Effect

Run `bun run vendor:effect` (idempotent), then read `repos/effect/LLMS.md` before writing Effect
code. Treat `repos/` as read-only reference: never import from it or make the build depend on it.
The vendored v4 source outranks Effect v3 documentation and model memory. Import one namespace per
module (`effect/Effect`, `effect/sql/SqlClient`). `bun run lint` rejects the `effect` barrel and area
barrels such as `effect/sql`. Confirm area APIs such as `effect/sql` and `effect/reactivity` in the
vendored source.

`bun run typecheck` runs `effect-tsgo tsc`, the Effect-patched TypeScript 7 compiler. It fails on
the Effect diagnostics set to `error` in `tsconfig.base.json`, among them `globalDate`,
`globalConsole`, `globalTimers`, `globalFetch`, `nodeBuiltinImport` and `preferSchemaOverJson`: use
the Effect services and `Schema` instead. Only `scripts/**` may use Node built-ins and `console`.

## Comments

- Default to none. Names, types, and tests carry the meaning.
- Before writing a comment, try to encode the fact instead: a type, an assertion, a test, or a lint
  rule. If one of those can hold it, write no comment.
- A comment survives only for a fact about something we cannot change, such as a third-party type
  that lies or a runtime quirk. State it concretely in one line.
- No doc comments on exports. Find callers with LSP references, not prose.
- Every `TODO` names the condition that makes it actionable.

## Pull requests

- Never open one unless the developer explicitly asks.
- Use conventional commit titles in plain language: `fix(web): new chats no longer spike CPU`.
- State the problem in a sentence or two, then how it was fixed.
- Rebase onto the latest main before opening.
- UI changes need before/after images; motion or timing needs a short video.
- Use squash merge and delete the source branch.
