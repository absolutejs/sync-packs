# @absolutejs/sync-pack-presence

Per-channel live presence for [`@absolutejs/sync`](https://github.com/absolutejs/sync).
Heartbeat-driven, scoped (per workspace/tenant), TTL-cleaned. Plugs into a
`SyncEngine` with one `engine.registerPack(...)` call.

```bash
bun add @absolutejs/sync-pack-presence
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createPresencePack } from '@absolutejs/sync-pack-presence';

const engine = createSyncEngine();
engine.registerPack(
	createPresencePack({
		// REQUIRED in practice: how the pack reads the current actor id from
		// your app's ctx. Default is `(ctx) => ctx.userId`.
		getActorId: (ctx) => ctx.session.userId,

		// OPTIONAL: tenant/workspace scope. Two scopes never see each other's
		// presence rows.
		scope: (ctx) => ctx.session.workspaceId,

		// OPTIONAL: TTL on a heartbeat (seconds). Default 30.
		heartbeatTtlSec: 30,

		// OPTIONAL: cron for the cleanup schedule. Default every 15 seconds.
		// You must still wire `@elysiajs/cron` to fire this — sync only owns
		// the handler, not the trigger.
		cleanupCron: '*/15 * * * * *'
	})
);
```

The pack exposes:

| Surface                | Name                  | What it does                                                          |
| ---------------------- | --------------------- | --------------------------------------------------------------------- |
| Collection             | `presence`            | Subscribe with `params: { channel }` — returns live members           |
| Mutation               | `presence:heartbeat`  | Upsert the caller's row in a channel and refresh its TTL              |
| Mutation               | `presence:leave`      | Delete the caller's row in a channel                                  |
| Schedule               | `presence:cleanup`    | Delete rows with `expiresAt <= now` (cron-fired by your host)          |

## Storage

By default the pack uses an in-memory store — presence is ephemeral and almost
always fine to lose on restart. To use a persistent backend (Drizzle, Postgres,
Redis, …) pass a custom `store`:

```ts
import { createPresencePack, type PresenceStore } from '@absolutejs/sync-pack-presence';

const store: PresenceStore = {
	reader: { all: () => /* SELECT * FROM presence */ },
	writer: {
		insert: (row) => /* INSERT */,
		update: (row) => /* UPDATE */,
		delete: (row) => /* DELETE */,
	},
	expired: (now) => /* SELECT * FROM presence WHERE expires_at <= $1 */
};

engine.registerPack(createPresencePack({ store, getActorId: (ctx) => ctx.userId }));
```

## Multiple instances

To run two presence packs on the same engine (e.g. one per product surface),
pass a `prefix` to each — it scopes the owned table, the collection name, the
mutation names, and the schedule name:

```ts
engine.registerPack(createPresencePack({ prefix: 'docs_', getActorId }));
engine.registerPack(createPresencePack({ prefix: 'chat_', getActorId }));

// Mutations are now `docs_presence:heartbeat` and `chat_presence:heartbeat`.
// Collections are `docs_presence` and `chat_presence`.
// Schedules are `docs_presence:cleanup` and `chat_presence:cleanup`.
```

## Composition

This pack composes via **subscriptions**, not cross-pack mutation calls. If
another pack wants to react to presence changes (e.g. a typing-indicator
display), it subscribes to the `presence` collection — it does not call
`presence:heartbeat` from inside its own handler. That keeps packs decoupled.

## What's in the `SyncPack`

`createPresencePack(config)` returns a plain `SyncPack` record:

- `ownsTables: ['presence']` (or `[`${prefix}presence`]`)
- `schemas`: field validators for the presence row
- `permissions`: read scoped to `scope(ctx)`, write requires
  `row.actorId === getActorId(ctx)`
- `readers` / `writers`: the in-memory store (or your custom one)
- `collections`: the per-channel live-members collection
- `mutations`: `presence:heartbeat` and `presence:leave`
- `schedules`: `presence:cleanup` with a retry policy

This is inspectable at runtime via `engine.inspect().packs`.
