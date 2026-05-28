# @absolutejs/sync-pack-digest

Scheduled per-actor digest emails as a sync pack for
[`@absolutejs/sync`](https://github.com/absolutejs/sync). Cron-fires a
schedule that iterates the host's actor list, asks the host to build a
digest payload, and dispatches it through a host-provided `send` adapter.
The pack does NOT ship an SMTP client — you bring your own (Resend, SES,
Postmark, or a CLI for tests).

```bash
bun add @absolutejs/sync-pack-digest
```

## Usage

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createDigestPack } from '@absolutejs/sync-pack-digest';

const engine = createSyncEngine();
engine.registerPack(
	createDigestPack({
		// Cron pattern for the digest fire. Default '0 8 * * 1' (Mon 8am).
		cron: '0 8 * * 1',

		// REQUIRED: yield the actor ids to iterate per fire. The host's
		// data layer is the source of truth for "who exists" — the pack
		// just maintains per-actor cursors.
		listActors: () => db.users.allActiveIds(),

		// REQUIRED: build the payload for one actor. `since` is the actor's
		// last successful send (or null on first-ever). Return null to skip
		// this actor silently (no content this week).
		buildDigest: async (actorId, since) => {
			const items = await db.feed.since(actorId, since ?? new Date(0));
			if (items.length === 0) return null;
			return {
				to: await db.users.email(actorId),
				subject: `Your weekly digest`,
				body: render(items),
			};
		},

		// REQUIRED: host's transport adapter. Pack catches throws per
		// actor so one bad send doesn't block the rest.
		send: async (msg) => await resend.send(msg),

		// OPTIONAL: back-pressure. Default 1000.
		maxActorsPerFire: 1000,

		// OPTIONAL: per-actor cool-down. Default 168 hours = 1 week. Match
		// to your cron — weekly cron + 168h = each actor gets one digest
		// per fire; daily cron + 168h = each actor gets at most one per week.
		minHoursBetweenDigests: 168,

		// OPTIONAL: surface failures (default logs to console.error).
		onActorFailure: ({ actorId, phase, error }) => {
			logger.warn({ actorId, phase, error }, 'digest failure');
		},

		// OPTIONAL: outer schedule retry (sync 1.9.0+). Defaults to no
		// retry — per-actor failures are handled internally; this is for
		// transient infra failures (DB, etc) of the whole fire. The next
		// cron fire catches up anyway.
		// retry: { maxAttempts: 3, backoff: exponentialBackoff() },
	})
);
```

## The pack exposes

| Surface     | Name              | What it does                                                               |
| ----------- | ----------------- | -------------------------------------------------------------------------- |
| Collection  | `digest_cursors`  | Subscribe (no params) — each actor sees their own `lastSentAt` cursor      |
| Schedule    | `digest:fire`     | Cron handler. Call `engine.runSchedule('digest:fire')` directly for tests  |

## Failure semantics

Three failure phases, each independent per actor:

| Phase         | Cause                          | Effect                                            |
| ------------- | ------------------------------ | ------------------------------------------------- |
| `buildDigest` | Host's content builder threw   | `onActorFailure` fires; cursor unchanged; skip    |
| `send`        | Host's transport adapter threw | `onActorFailure` fires; cursor unchanged; skip    |
| `cursor`      | Cursor update failed post-send | `onActorFailure` fires (email already went out)   |

A failure on actor N doesn't affect actor N+1; the schedule keeps going.

The `cursor` phase is the one to watch: the email already went out but the
cursor didn't update, so the actor may double-receive next fire. The pack
logs through `onActorFailure` so the operator notices.

## Cursor row

```ts
type DigestCursor = {
	id: string; // = actorId
	actorId: string;
	lastSentAt: number; // epoch ms
	lastSubject: string;
};
```

The collection is scoped per actor by default (each actor sees only their
own cursor — useful for a "last digest: 5 days ago" UI). Hosts who want
an admin view can register their own permissions on top — host wins-last.

## Storage

Default: per-instance in-memory cursor store. For a persistent backend,
pass a custom `store`:

```ts
import {
	createDigestPack,
	type DigestStore,
} from '@absolutejs/sync-pack-digest';

const store: DigestStore = {
	getById: (id) => /* SELECT * FROM digest_cursors WHERE id = $1 */,
	reader: { all: () => /* SELECT * FROM digest_cursors */ },
	writer: { insert, update, delete },
};
```

## Multiple instances

Pass a `prefix` to coexist with other digest pack instances (e.g. one per
product surface, with different crons / templates):

```ts
engine.registerPack(createDigestPack({ prefix: 'team_', /* ... */ }));
engine.registerPack(createDigestPack({ prefix: 'cust_', /* ... */ }));

// Tables:       team_digest_cursors,  cust_digest_cursors
// Schedules:    team_digest:fire,     cust_digest:fire
// Collections:  team_digest_cursors,  cust_digest_cursors
```
