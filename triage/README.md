# @absolutejs/sync-pack-triage

Per-actor triage state for [`@absolutejs/sync`](https://github.com/absolutejs/sync): unread/seen, snooze, dismiss, and mute over any resource your app already owns.

Every product with a backlog — an inbox, a task list, a review queue, a deal room — grows the same four controls, and every product rebuilds them. This pack owns one `triage` table keyed by `(actorId, resourceKind, resourceId)` and gives you the mutations and the owner-scoped live collection to drive them.

```bash
bun add @absolutejs/sync-pack-triage
```

```ts
import { createSyncEngine } from "@absolutejs/sync/engine";
import { createTriagePack } from "@absolutejs/sync-pack-triage";

const engine = createSyncEngine();
engine.registerPack(createTriagePack({ getActorId: (ctx) => ctx.userId }));

await engine.runMutation(
  "triage:snooze",
  {
    resourceId: "thread-9",
    resourceKind: "thread",
    snoozedUntil: Date.now() + 86_400_000,
  },
  { userId: "alice" },
);

const view = await engine.subscribe({
  collection: "triage",
  ctx: { userId: "alice" },
  onDiff: (diff) => render(diff),
  params: { resourceKind: "thread", status: "active" },
});
```

## The two rules that matter

**Dismiss sticks.** New activity does not resurrect something the actor put away. A "dismiss" that quietly means "hide until it changes" brings the item back at the worst possible moment, and the actor stops trusting the control. Only `triage:restore` undoes a dismiss.

**Snooze resurfaces.** A snoozed item comes back the moment the other side acts — not when its timer happens to expire. Waiting out a three-day snooze while a reply sits hidden is how a deal dies. This is the Gmail norm and the one people expect.

Both live in one pure function, so you can apply the same rule inside your own SQL-backed list query without instantiating the pack:

```ts
import { triageVisibility, isUnread } from "@absolutejs/sync-pack-triage";

triageVisibility(row, { lastActivityAt: thread.lastMessageAt }); // 'active' | 'snoozed' | 'dismissed'
isUnread(row, thread.lastMessageAt); // never looked, or changed since they did
```

Pass `lastActivityAt` and a snooze ends early when the resource changes. Omit it and a snooze ends only on its timer.

## Mutations

| Mutation                        | Args                                        | Effect                                                              |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `triage:seen`                   | `{resourceKind, resourceId}`                | Stamps `lastSeenAt`                                                 |
| `triage:unread`                 | `{resourceKind, resourceId}`                | Clears `lastSeenAt`                                                 |
| `triage:snooze`                 | `{resourceKind, resourceId, snoozedUntil?}` | `status: 'snoozed'`; `snoozedUntil: null` sleeps until new activity |
| `triage:dismiss`                | `{resourceKind, resourceId}`                | `status: 'dismissed'`, stamps `dismissedAt`                         |
| `triage:restore`                | `{resourceKind, resourceId}`                | Back to `status: 'active'`                                          |
| `triage:mute` / `triage:unmute` | `{resourceKind, resourceId}`                | Stop/resume notifying, without putting it away                      |
| `triage:bulk`                   | `{action, resources[], snoozedUntil?}`      | One round-trip, one diff, for a multi-select                        |

Row ids are `${actorId}:${resourceKind}:${resourceId}`, so every mutation is an idempotent upsert and a row's owner is recoverable from its key. Read and write permissions are owner-scoped and enforced against the stored row, not the client's payload.

## Config

```ts
createTriagePack({
  getActorId: (ctx) => ctx.userId, // default reads ctx.userId
  prefix: "team_", // namespaces table, collection, mutations, schedule
  store: myPostgresTriageStore, // default is per-instance in-memory
  now: () => Date.now(),
  maxBulkSize: 500,
  wakeCron: "*/5 * * * *", // null to skip registering the sweep
});
```

`store` is three functions — `all`, `getById`, and a `TableWriter` — and both reads may be async, so you can back triage with your real database rather than a mirror.

The `wakeCron` sweep only exists to turn an expired snooze into a live change event. Reads are already correct without it, because `triageVisibility` resolves expiry at read time; a host that hasn't wired the `scheduled` plugin still behaves correctly, just without a push at the moment of expiry.

## Subscription params

`{ resourceKind?, status? }`. Both are optional; `status` is resolved with `triageVisibility` at the current time and **without** a per-row activity timestamp, because this pack owns triage state and not your activity feed. If you want activity-aware resurfacing inside a live query, join this table in your own collection and call `triageVisibility` there with your own timestamp.

## License

Apache-2.0
