# kymo

## Stage

Single operator: the operator is the only one running kymo, so no database needs to survive a schema
change. Change the schema by editing the first migration (`0001`) in place; the operator deletes
`~/.kymo` when a change needs it. APIs and in-memory types change in place too: migrate every caller
and delete the old path in the same change, with no compatibility shims.

## Layout

- Workspaces live under three roots: `packages/`, `apps/`, and `plugins/`.
- Runtime dependencies point only downward:
  - `packages/contract` (`@kymo/contract`): types and schemas shared by the daemon, the CLI and the
    web UI.
  - `apps/daemon` (`@kymo/daemon`), `apps/cli` (`@kymo/cli`) and `apps/web` (`@kymo/web`) each
    depend on `@kymo/contract`. The CLI talks to the daemon over HTTP only.
- Nothing under `packages/`, `apps/`, or `plugins/` imports from `design/`.

## Reference

- `design/prototype/g-fusion.html` is the UI reference. Serve it with the paseo `prototype` script
  or `cd design/prototype && python3 -m http.server <port>`.

## Web

- `useEffect`, `useLayoutEffect` and `useInsertionEffect` are banned by `bun run lint`. Derive during
  render or use an event handler; `useMountEffect` in `apps/web/src/useMountEffect.ts` is the only
  escape.
- The URL holds navigable UI state, through TanStack Router search params.

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
