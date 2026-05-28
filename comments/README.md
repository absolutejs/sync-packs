# @absolutejs/sync-pack-comments

Threaded comments as a sync pack for
[`@absolutejs/sync`](https://github.com/absolutejs/sync). Per-resource ACL
injection, author/moderator gates, optional CRDT bodies. Plugs into a
`SyncEngine` with one `engine.registerPack(...)` call.

```bash
bun add @absolutejs/sync-pack-comments
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createCommentsPack } from '@absolutejs/sync-pack-comments';

const engine = createSyncEngine();
engine.registerPack(
	createCommentsPack({
		// REQUIRED: gate read access on a resource. The host knows which
		// resources a given ctx can see; the pack does not duplicate that.
		canReadResource: (resourceId, ctx) =>
			hostAcl.canRead(resourceId, ctx.session.userId),

		// REQUIRED in practice: how the pack reads the current actor id
		// from your app's ctx. Default is `(ctx) => ctx.userId`.
		getActorId: (ctx) => ctx.session.userId,

		// OPTIONAL: moderator predicate. Used by comments:delete (author OR
		// moderator can delete). Default `() => false`.
		canModerate: (ctx) => ctx.session.isModerator,

		// OPTIONAL: max thread depth (top-level = 0). Default 8.
		maxDepth: 8,

		// OPTIONAL: wire the comment body as a CRDT field via registerCrdt
		// so concurrent edits merge instead of clobbering. Pass anything
		// implementing `CrdtMergeable<T>` — e.g. yjsText from
		// @absolutejs/sync-yjs. The pack does NOT import Yjs.
		// bodyCrdt: yjsText,
	})
);
```

## The pack exposes

| Surface     | Name                | What it does                                                            |
| ----------- | ------------------- | ----------------------------------------------------------------------- |
| Collection  | `comments`          | Subscribe with `params: { resourceId }` — returns the comment tree      |
| Mutation    | `comments:create`   | Args: `{ resourceId, body, parentCommentId? }` — stamps `authorId`      |
| Mutation    | `comments:edit`     | Args: `{ commentId, body }` — author only, stamps `editedAt`            |
| Mutation    | `comments:delete`   | Args: `{ commentId }` — author or moderator                             |

When `bodyCrdt` is set, the engine auto-registers a `comments:merge`
mutation through `registerCrdt` — clients call that to merge CRDT body
updates concurrently with regular edits.

## Row shape

```ts
type CommentRow = {
	id: string;
	resourceId: string;
	parentCommentId: string | null; // null on top-level; parent id on replies
	authorId: string;
	body: string;
	depth: number; // 0 for top-level, parent.depth + 1 for replies
	createdAt: number;
	editedAt: number | null;
};
```

The collection returns a flat list of rows for the resource; the client
builds the tree by walking `parentCommentId`. Depth is stored on the row
so a client can short-circuit-render without traversing the full chain.

## Storage

Default: per-instance in-memory store. To use a persistent backend (Drizzle,
Postgres, …), pass a custom `store`:

```ts
import {
	createCommentsPack,
	type CommentsStore,
} from '@absolutejs/sync-pack-comments';

const store: CommentsStore = {
	getById: (id) => /* SELECT * FROM comments WHERE id = $1 */,
	reader: { all: () => /* SELECT * FROM comments */ },
	writer: {
		insert: (row) => /* INSERT */,
		update: (row) => /* UPDATE */,
		delete: (row) => /* DELETE WHERE id = $1 */,
	},
};

engine.registerPack(createCommentsPack({ store, canReadResource, getActorId }));
```

The `getById` method is required (used by edit + delete to verify ownership
and by create to walk the parent chain for depth math).

## Multiple instances

To run two comments packs on the same engine (e.g. one per product
surface), pass a `prefix` to each. It scopes the owned table, the
collection, and the mutation names:

```ts
engine.registerPack(createCommentsPack({ prefix: 'docs_', canReadResource, getActorId }));
engine.registerPack(createCommentsPack({ prefix: 'chat_', canReadResource, getActorId }));

// Tables:       docs_comments,        chat_comments
// Collections:  docs_comments,        chat_comments
// Mutations:    docs_comments:create, chat_comments:create  (etc.)
```

## Composition

This pack composes with the rest of your sync graph via **subscriptions**.
A presence pack that wants to show "Alice is replying to this thread" should
subscribe to `comments` and `presence` separately — it should NOT call
`comments:*` from inside its own handler. See the design doc rules in
[`syncPacks.design.md`](https://github.com/absolutejs/sync/blob/main/src/engine/syncPacks.design.md).

## Optional: `comments-with-author` join collection (0.2+)

Set `joinUsers` to additionally register a `comments-with-author` join
collection that pairs each comment with the host's user row. The pack does
NOT own the users table; it adds it to `readsTables` so the engine knows
the dependency and your devtools see the full graph.

```ts
type Author = { id: string; displayName: string; avatarUrl?: string };

engine.registerReader('users', { all: () => db.users.list() });
engine.registerWriter('users', { /* ... */ });

engine.registerPack(
	createCommentsPack<MyCtx, Author>({
		canReadResource,
		getActorId,
		joinUsers: {
			// Default 'users'; pass another name if your table differs.
			table: 'users',
			// Default (u) => u.id; override if your user id key isn't `id`.
			// key: (user) => user.userId,
			// Required: host supplies the users-side hydrate.
			hydrate: () => db.users.list(),
		},
	}),
);

// Subscribe with the same params shape as the base collection.
const subscription = await engine.subscribe<
	CommentRow & { author: Author },
	{ resourceId: string }
>({
	collection: 'comments-with-author',
	params: { resourceId },
	ctx,
	onDiff: rerender,
});
// subscription.initial[0] === { ...comment, author: { id, displayName, ... } }
```

The engine inner-joins on `comment.authorId === user.id`; comments
whose author is missing from the users table are excluded from the join
(but still appear in the base `comments` collection). `canReadResource`
gates the join the same way it gates the base.

## Planned for 0.3+

- **In-thread full-text search** via `registerSearch` on the comments
  table.
- **Reactions** — a `reactionsTable` config that adds an emoji-reaction
  side table with create/remove/list mutations.
