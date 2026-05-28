# @absolutejs/sync-pack-counters

Read-set-tracked live counters for
[`@absolutejs/sync`](https://github.com/absolutejs/sync). Define a compute
function that reads through `db`; the engine re-runs and pushes the new
value whenever any table the compute read changes. No manual invalidation,
no polling, no operator graph — just a function.

```bash
bun add @absolutejs/sync-pack-counters
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createCountersPack } from '@absolutejs/sync-pack-counters';

const engine = createSyncEngine();
engine.registerReader('tasks',         { all: () => db.tasks.list() });
engine.registerReader('notifications', { all: () => db.notifications.list() });

engine.registerPack(
	createCountersPack({
		counters: {
			// Bare function form.
			openTasks: async ({ db }) =>
				(await db.all<Task>('tasks')).filter((t) => !t.done).length,

			// Per-actor counter using ctx.
			unreadNotifications: async ({ db, ctx }) =>
				(await db.all<Notification>('notifications'))
					.filter((n) => n.actorId === ctx.userId && n.readAt === null)
					.length,

			// Object form when you need a per-counter authorize override —
			// e.g. a public site-wide stat anyone can subscribe to.
			totalUsers: {
				authorize: () => true,
				compute: async ({ db }) => (await db.all('users')).length,
			},
		},
	}),
);
```

Each counter becomes its own reactive query collection named
`counter:<key>` returning a single row. Subscribe from the client:

```ts
useSyncCollection<CounterRow>({ collection: 'counter:openTasks' });
// Emits { id: 'openTasks', key: 'openTasks', value: 3, computedAt: ... }
```

## Why `defineReactiveQuery`?

The pack is one big use case for sync's read-set tracking: a counter is
literally "compute a number from one or more tables, and re-emit it when
those tables change." The engine instruments every `db.all` / `db.get` /
`db.where` your compute makes, records the resulting dependency set, and
parks the query on it. Any subsequent change to a touched table triggers
a re-run; rows that didn't change don't.

Prefer `db.where(table, predicate)` over `db.all(table).filter(...)`
when possible — `where` records a **range** dependency that re-runs only
when a change matches the predicate now or matched it before, instead of
on every change to the table.

## Permissions

The default `authorize` requires the caller's ctx to expose an actor id
(via `getActorId`, defaulting to `(ctx) => ctx.userId`). Per-counter
`authorize` overrides this — return `() => true` for a public counter,
or implement role-based gating.

## What the pack ships

| Surface              | Name                  | What it does                               |
| -------------------- | --------------------- | ------------------------------------------ |
| Reactive query (×N)  | `counter:<key>`       | One per counter; emits a single CounterRow |

The pack owns no tables and reads no tables of its own — every counter's
read-set comes from the host's registered readers. `engine.inspect().packs[0]`
reports empty `ownsTables` and `readsTables`.

## Multiple instances

Pass `prefix` to coexist with another counters pack instance:

```ts
engine.registerPack(createCountersPack({ prefix: 'team_', counters: { ... } }));
engine.registerPack(createCountersPack({ prefix: 'org_',  counters: { ... } }));
// Collections: team_counter:<key> and org_counter:<key>
```
