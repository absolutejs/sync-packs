# @absolutejs/sync-pack-favorites

Per-actor saved-resources pack for
[`@absolutejs/sync`](https://github.com/absolutejs/sync). Each actor sees
only their own rows; favoriting is idempotent (deterministic row id);
optional join collection pairs each favorite with the host's resource
row in one live subscription.

```bash
bun add @absolutejs/sync-pack-favorites
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createFavoritesPack } from '@absolutejs/sync-pack-favorites';

const engine = createSyncEngine();
engine.registerPack(
	createFavoritesPack({
		getActorId: (ctx) => ctx.session.userId,
	}),
);
```

Then from the client:

```ts
// Toggle is the easy default — one round-trip, returns the new state.
const { favorited } = await store.mutate({
	args: { resourceKind: 'doc', resourceId: 'doc-123' },
	name: 'favorites:toggle',
});

// Or favorite / unfavorite explicitly.
await store.mutate({ args: { resourceKind: 'doc', resourceId: 'doc-123' }, name: 'favorites:favorite' });
await store.mutate({ args: { resourceKind: 'doc', resourceId: 'doc-123' }, name: 'favorites:unfavorite' });
```

## The pack exposes

| Surface     | Name                          | What it does                                                |
| ----------- | ----------------------------- | ----------------------------------------------------------- |
| Collection  | `favorites`                   | Per-actor list. Optional `params.resourceKind` filter       |
| Mutation    | `favorites:favorite`          | Idempotent insert. Subsequent calls are no-ops              |
| Mutation    | `favorites:unfavorite`        | Idempotent delete. No-op if the row never existed           |
| Mutation    | `favorites:toggle`            | Insert if missing, delete if present. Returns `{ favorited }` |
| Collection  | `favorites-with-resource` (opt) | Join with the host's resource table — see below           |

## Row shape

```ts
type FavoriteRow = {
	id: string;              // `${actorId}:${resourceKind}:${resourceId}` — deterministic
	actorId: string;
	resourceKind: string;    // app-level: "doc" | "task" | "issue" | ...
	resourceId: string;
	createdAt: number;
};
```

The deterministic id means the same `(actor, kind, resource)` triple
always maps to the same row — so duplicate `favorite` calls are
idempotent at the storage layer, not just behaviorally.

## Optional: `favorites-with-resource` join

When you set `joinResources`, the pack additionally registers a join
collection that pairs each favorite with the host's resource row (same
pattern as comments-with-author from sync-pack-comments).

```ts
type DocRow = { id: string; title: string };

engine.registerReader('docs', { all: () => db.docs.list() });
engine.registerPack(
	createFavoritesPack<MyCtx, DocRow>({
		getActorId,
		joinResources: {
			table: 'docs',
			// Default (row) => row.id; override if your resource id key isn't `id`.
			// key: (doc) => doc.docId,
			// Required: host supplies the resource-side hydrate.
			hydrate: () => db.docs.list(),
		},
	}),
);

const view = await engine.subscribe<
	FavoriteRow & { resource: DocRow },
	{ resourceKind?: string }
>({
	collection: 'favorites-with-resource',
	params: { resourceKind: 'doc' },
	ctx,
	onDiff: rerender,
});
// view.initial[0] === { ...favorite, resource: { id, title } }
```

Inner join — favorites whose resource has been deleted drop out of the
join (but stay in the base `favorites` collection).

## Storage

Default: per-instance in-memory store. For a persistent backend, pass a
custom `store`:

```ts
import { type FavoritesStore } from '@absolutejs/sync-pack-favorites';

const store: FavoritesStore = {
	getById: (id) => /* SELECT * FROM favorites WHERE id = $1 */,
	reader: { all: () => /* SELECT */ },
	writer: { insert, update, delete },
};
```

## Multiple instances

Pass a `prefix` to coexist with another favorites pack instance (e.g. a
"team" set vs a "private" set):

```ts
engine.registerPack(createFavoritesPack({ prefix: 'team_', /* ... */ }));
engine.registerPack(createFavoritesPack({ prefix: 'private_', /* ... */ }));
```
