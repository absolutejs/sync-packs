# @absolutejs/sync-pack-mentions

`@username` parser pack for [`@absolutejs/sync`](https://github.com/absolutejs/sync). Owns a `mentions` table, parses bodies for `@usernames`, writes per-actor mention rows, and fires an `onMention` hook the host wires into other packs.

```ts
import { createSyncEngine } from '@absolutejs/sync/engine';
import { createMentionsPack } from '@absolutejs/sync-pack-mentions';

const engine = createSyncEngine();

engine.registerPack(
  createMentionsPack({
    getActorId: (ctx) => ctx.session.userId,
    resolveActorId: async (username) => userIdByUsername(username),
    onMention: async ({ mention }, ctx) => {
      await engine.runMutation(
        'notifications:notify',
        {
          targetActorId: mention.mentionedActorId,
          kind: 'mention',
          title: 'You were mentioned',
          body: mention.snippet,
          href: `/comments/${mention.sourceId}`,
        },
        ctx,
      );
    },
  }),
);
```

The `onMention` hook is the seam. Packs in `@absolutejs/sync-packs` never call each other's mutations directly; the host wires them together. This pack provides the parser + the collection; you decide whether mentions fire notifications, emails, Slack pings, or anything else.

## Surface

| | |
|---|---|
| `ownsTables` | `mentions` |
| Collections | `mentions` (per-actor view, filterable by `sourceKind` / `unresolvedOnly`) |
| Mutations | `mentions:record { sourceKind, sourceId, body, authorId? }`, `mentions:resolve { id }`, `mentions:dismiss { id }` |
| Permissions | only the mentioned actor reads, updates, deletes their rows; `insert` is host-trusted (the pack itself writes on the author's behalf) |

## Composition pattern

The host calls `mentions:record` **right after** its own post mutation succeeds, then `onMention` fires once per parsed mention. From inside the hook, the host can `engine.runMutation('notifications:notify', …)` to compose with `@absolutejs/sync-pack-notifications`.

Mention rows are idempotent (`(sourceKind, sourceId, mentionedActorId)` is the primary key), so re-calling `mentions:record` on an edit of the same source body does **not** re-fire `onMention` for the same target. Self-mentions are skipped automatically.

## License

CC BY-NC 4.0 — same as the rest of the @absolutejs ecosystem.
