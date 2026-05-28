# @absolutejs/sync-packs

Feature packs for [`@absolutejs/sync`](https://github.com/absolutejs/sync) — a
private workspace monorepo. Each pack is published as its own npm package and
plugs into a `SyncEngine` with one `engine.registerPack(...)` call. See
[`syncPacks.design.md`](https://github.com/absolutejs/sync/blob/main/src/engine/syncPacks.design.md)
for the API rationale.

| Pack         | Package                            | What it ships                                                      | Status     |
| ------------ | ---------------------------------- | ------------------------------------------------------------------ | ---------- |
| `presence/`  | `@absolutejs/sync-pack-presence`   | Per-channel live presence (heartbeat + scoped reads + TTL cleanup) | ✅ 0.1.0    |
| `comments/`  | `@absolutejs/sync-pack-comments`   | Threaded comments on host-side resources (planned)                 | 🟡 planned |
| `digest/`    | `@absolutejs/sync-pack-digest`     | Scheduled per-actor digest emails (planned)                        | 🟡 planned |

## Why packs

Convex's "Components" model bundles schema + mutations + scheduled jobs +
permissions as a reusable unit, and it's their stickiest moat — pulling one
out means rewriting the application. Sync packs ship the same productivity
**as a portable unit**: one npm install, one factory call. No lock-in.

## Design rules (locked, do not re-debate)

- **Each pack is a factory.** `create<Name>Pack(config)` returns a `SyncPack`.
  Namespacing (table prefix) and config injection (host's user table,
  `getActorId`, `scope`) are the pack's job — the engine does not rewrite
  names.
- **Composition is subscription-only.** Packs subscribe to each other's
  collections. Packs MUST NOT call cross-pack `engine.runMutation`.
- **Plain data + identity helper.** A pack is the `SyncPack` record returned
  from `defineSyncPack(pack)` — JSON-inspectable, no classes.
- **Generic params are `any`, not `unknown`.** TypeScript function-parameter
  contravariance forces this; matches the engine's internal maps.
- **0.x through pack #3.** Don't promote `SyncPack` to v1 until presence +
  comments + digest all ship and the API has been exercised.
