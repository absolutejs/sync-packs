# @absolutejs/sync-pack-notifications

Per-actor inbox pack for [`@absolutejs/sync`](https://github.com/absolutejs/sync).
Each actor sees only their own rows; `notify` is the host-trusted insert
path; `markRead` and `markAllRead` are client-callable owner-only mutations.
Optional `autoArchiveAfterDays` deletes rows past TTL via a cron schedule.

```bash
bun add @absolutejs/sync-pack-notifications
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createNotificationsPack } from '@absolutejs/sync-pack-notifications';

const engine = createSyncEngine();
engine.registerPack(
	createNotificationsPack({
		getActorId: (ctx) => ctx.session.userId,
		// `notify` is the trusted insert path. Mark the ctx your host
		// uses to call notify as a moderator so the row-author permission
		// check passes. (In a real app this is a server-only "system"
		// trust flag, not isModerator.)
		canModerate: (ctx) => ctx.session.systemTrusted === true,
		// Optional: archive rows after 30 days. Cleanup schedule fires
		// hourly by default.
		autoArchiveAfterDays: 30,
	}),
);

// From any server-side path (a webhook, a schedule, another mutation):
await engine.runMutation(
	'notifications:notify',
	{
		actorId: 'alice',
		kind: 'mention',
		title: 'You were mentioned',
		body: 'in @doc-123 by bob',
		href: '/docs/123#comment-456',
	},
	{ session: { systemTrusted: true } },
);
```

## The pack exposes

| Surface     | Name                          | What it does                                            |
| ----------- | ----------------------------- | ------------------------------------------------------- |
| Collection  | `notifications`               | Each actor sees their own rows; moderators see all      |
| Mutation    | `notifications:notify`        | Insert one row for a target actor (host-trusted)        |
| Mutation    | `notifications:markRead`      | Stamp `readAt` on one row — owner only                  |
| Mutation    | `notifications:markAllRead`   | Bulk-mark every unread row in the caller's inbox        |
| Schedule    | `notifications:cleanup`       | (Only if `autoArchiveAfterDays` set) deletes expired    |

## Row shape

```ts
type NotificationRow = {
	id: string;
	actorId: string;       // whose inbox
	kind: string;          // app-level tag: "mention", "reply", "system", ...
	title: string;
	body: string;
	href: string | null;   // optional jump-to URL
	createdAt: number;
	readAt: number | null; // null = unread
	expiresAt: number | null;
};
```

## Storage

Default: per-instance in-memory store. For a persistent backend pass a
custom `store`:

```ts
import {
	createNotificationsPack,
	type NotificationsStore,
} from '@absolutejs/sync-pack-notifications';

const store: NotificationsStore = {
	getById: (id) => /* SELECT * FROM notifications WHERE id = $1 */,
	expired: (now) => /* SELECT * FROM notifications WHERE expires_at <= $1 */,
	reader: { all: () => /* SELECT */ },
	writer: { insert, update, delete },
};
```

`getById` is required (used by `markRead` to verify ownership before update).
`expired` is required when `autoArchiveAfterDays` is set.

## Multiple instances

Pass `prefix` to coexist with another notifications pack instance (e.g. a
separate "system" inbox vs the regular one):

```ts
engine.registerPack(createNotificationsPack({ prefix: 'user_', /* ... */ }));
engine.registerPack(createNotificationsPack({ prefix: 'system_', /* ... */ }));
```
