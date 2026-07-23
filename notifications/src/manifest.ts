import { defineManifest, toolFactory } from "@absolutejs/manifest";
import type { SyncPack } from "@absolutejs/sync/engine";
import { Type } from "@sinclair/typebox";
import type { NotificationsPackConfig } from "./index";

const tool = toolFactory<SyncPack>();

/* Serializable subset of NotificationsPackConfig: prefix + auto-archive
 * knobs. getActorId / canModerate / store / now / newId are function-or-
 * instance-valued → wiring concerns. */
export const manifest = defineManifest<NotificationsPackConfig, SyncPack>()({
  contract: 2,
  identity: {
    accent: "#ef4444",
    category: "sync",
    description:
      "Per-actor inbox pack for `@absolutejs/sync` — one `engine.registerPack(createNotificationsPack(...))` adds a live notification inbox: a notify mutation any server code can call, owner-scoped reads, mark-read (with an optional moderator override), and optional TTL auto-archive on a cleanup schedule.",
    docsUrl: "https://github.com/absolutejs/sync-packs/tree/main/notifications",
    name: "@absolutejs/sync-pack-notifications",
    tagline: "Give every member a live in-app notification inbox.",
  },
  settings: Type.Object({
    autoArchiveAfterDays: Type.Optional(
      Type.Number({
        description:
          "Automatically delete notifications this many days after they’re created. Leave unset to keep them forever.",
        minimum: 0,
        title: "Auto-archive after (days)",
      }),
    ),
    autoArchiveCron: Type.Optional(
      Type.String({
        description:
          "How often expired notifications are cleaned up (cron syntax). Only used when auto-archive is on. Default hourly.",
        examples: ["0 * * * *"],
        title: "Cleanup schedule",
      }),
    ),
    prefix: Type.Optional(
      Type.String({
        description:
          "Name prefix for the pack’s table, collection, and mutations.",
        title: "Name prefix",
      }),
    ),
  }),
  tools: {
    pack_surface: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "owner",
        effects: ["read"],
        requiredScopes: ["sync:packs:read"],
      },
      description:
        "What this notifications pack adds to the sync engine: the inbox table it owns, its collection, mutations (notify / markRead), and any cleanup schedule.",
      handler: (_input, pack) =>
        JSON.stringify({
          collections: (pack.collections ?? []).map(
            (collection) => collection.name,
          ),
          mutations: (pack.mutations ?? []).map((mutation) => mutation.name),
          name: pack.name,
          ownsTables: pack.ownsTables,
          schedules: (pack.schedules ?? []).map((schedule) => ({
            name: schedule.name,
            pattern: schedule.pattern,
          })),
          version: pack.version,
        }),
      input: Type.Object({}),
    }),
  },
  wiring: [
    {
      description:
        "Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding. Composes with the mentions pack (call notify from onMention) and the digest pack.",
      id: "default",
      server: {
        code: [
          "// getActorId defaults to (ctx) => ctx.userId; add canModerate for",
          "// admin “clear anyone’s inbox” tooling.",
          "engine.registerPack(createNotificationsPack(${settings}));",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/sync-pack-notifications",
            names: ["createNotificationsPack"],
          },
        ],
        placement: "module-scope",
      },
      title: "Register the notification inbox on the sync engine",
    },
  ],
});
