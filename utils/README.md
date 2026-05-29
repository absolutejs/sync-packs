# @absolutejs/sync-pack-utils

Shared helpers for [`@absolutejs/sync`](https://github.com/absolutejs/sync)
packs. Each helper closes one repeated pattern that showed up across the six
official packs (presence, comments, digest, notifications, favorites,
counters). The goal: make new packs — first- or third-party — cheaper to
write and consistent with what's already shipped.

```bash
bun add @absolutejs/sync-pack-utils
```

## API

### Actor resolution

```ts
import {
	defaultGetActorId,
	resolveActor,
} from '@absolutejs/sync-pack-utils';

// (ctx) => ctx.userId — the conventional default.
const getActorId = config.getActorId ?? defaultGetActorId<MyCtx>();

// Inside a mutation handler: throws UnauthorizedError if no actor id.
// The context string ends up in the error message so logs name the op.
const actorId = resolveActor(getActorId, ctx, 'mypack:create');
```

### Permission builders

```ts
import {
	requireRowOwner,
	requireOwnerOrModerator,
} from '@absolutejs/sync-pack-utils';

permissions: {
	[table]: {
		read: ...,
		// Owner-only writes — uses row.actorId by default; override the
		// field name for packs that use authorId, userId, etc.
		insert: requireRowOwner(getActorId, 'actorId'),
		update: requireRowOwner(getActorId, 'actorId'),
		// Owner OR moderator delete. Falls back to store.getById when
		// actions.delete supplied only the row key (the common case).
		delete: requireOwnerOrModerator({
			actorIdField: 'actorId',
			canModerate,        // optional
			getActorId,
			store,              // { getById }
		}),
	},
},
```

`requireRowOwner` and `requireOwnerOrModerator` are higher-order — call
them once at pack-build time to receive the per-row predicate the engine
expects. Both reject when `getActorId(ctx)` is `undefined` (anonymous
callers can't own a row).

### In-memory store

```ts
import {
	createInMemoryStore,
	type InMemoryStore,
} from '@absolutejs/sync-pack-utils';

type FavoriteRow = { id: string; actorId: string; /* ... */ };

const store: InMemoryStore<FavoriteRow> =
	config.store ?? createInMemoryStore<FavoriteRow>();

engine.registerPack(defineSyncPack({
	// ...
	readers: { favorites: store.reader },
	writers: { favorites: store.writer },
	// store.getById is available for permission + mutation handler use.
}));
```

`createInMemoryStore<Row>()` returns:

- `reader: TableReader<CollectionContext>` — `all()` returns `[...rows.values()]`
- `writer: TableWriter<Row>` — upsert-by-id; `delete` removes by `row.id`
- `getById(id)` — point lookup
- `rows: Map<string, Row>` — direct access (treat as read-only)

Every official pack uses this as its default backing store and exposes a
`store?: ...` config field so consumers can swap in a Postgres / Drizzle /
Redis implementation when they need persistence.

## What's intentionally not here

- **`prefixed(prefix, ...)`**: just use template literals.
  ``${prefix}<my-collection>`` is fine.
- **`defineActorPack(...)`**: a Convex-style abstraction that wraps
  `defineSyncPack` with permission defaults. Decided against — it'd hide
  the engine surface, which is the thing pack authors learn first.
- **Validators / Zod adapters**: out of scope; sync's `field` helper +
  schema is the validation layer.

## Pairing with `@absolutejs/sync/testing`

Pack tests typically pair with `@absolutejs/sync/testing` (added in sync
1.9.2):

```ts
import { expectRejection } from '@absolutejs/sync/testing';
import { resolveActor } from '@absolutejs/sync-pack-utils';

const error = await expectRejection(() => {
	resolveActor(getActorId, {}, 'mypack:do');
	return Promise.resolve();
});
expect(error).toBeInstanceOf(UnauthorizedError);
```

## Versioning

This package stays 0.x indefinitely while the ecosystem settles. When the
six official packs are stable, the helpers will follow.
