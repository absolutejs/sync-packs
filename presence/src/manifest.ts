import { defineManifest, toolFactory } from "@absolutejs/manifest";
import type { SyncPack } from "@absolutejs/sync/engine";
import { Type } from "@sinclair/typebox";
import type { PresencePackConfig } from "./index";

const tool = toolFactory<SyncPack>();

/* Serializable subset of PresencePackConfig: prefix + the TTL/cron knobs.
 * getActorId / scope / canAccessChannel / store / now are function-or-
 * instance-valued → wiring concerns (getActorId defaults to ctx.userId). */
export const manifest = defineManifest<PresencePackConfig, SyncPack>()({
  contract: 2,
  identity: {
    accent: "#22c55e",
    category: "sync",
    description:
      "Per-channel live presence pack for `@absolutejs/sync` — one `engine.registerPack(createPresencePack(...))` adds heartbeat-driven who’s-online, typing indicators, and cursor/state patches, with scoped reads, an optional per-channel ACL, and TTL cleanup on a schedule. Storage is in-memory by default and pluggable.",
    docsUrl: "https://github.com/absolutejs/sync-packs/tree/main/presence",
    name: "@absolutejs/sync-pack-presence",
    tagline: "Show who’s online and typing, live, in any room.",
  },
  settings: Type.Object({
    cleanupCron: Type.Optional(
      Type.String({
        description:
          "How often stale presence rows are swept (cron syntax; a leading 6th field is seconds). Default every 15 seconds.",
        examples: ["*/15 * * * * *"],
        title: "Cleanup schedule",
      }),
    ),
    heartbeatTtlSec: Type.Optional(
      Type.Number({
        description:
          "Seconds someone stays “online” after their last heartbeat. Default 30.",
        minimum: 1,
        title: "Online timeout",
      }),
    ),
    prefix: Type.Optional(
      Type.String({
        description:
          "Name prefix for the pack’s table, collection, and mutations — set one when running several presence packs on the same engine.",
        title: "Name prefix",
      }),
    ),
    typingTtlSec: Type.Optional(
      Type.Number({
        description:
          "Seconds a typing indicator stays active after the last keystroke ping. Default 5.",
        minimum: 1,
        title: "Typing timeout",
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
        "What this presence pack adds to the sync engine: the tables it owns, its collections, mutations, and cleanup schedule.",
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
        "Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding. Clients join rooms with createPresence from @absolutejs/sync/client.",
      id: "default",
      server: {
        code: [
          "// getActorId defaults to (ctx) => ctx.userId; override it (and add",
          "// scope / canAccessChannel) when your socket context differs.",
          "engine.registerPack(createPresencePack(${settings}));",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/sync-pack-presence",
            names: ["createPresencePack"],
          },
        ],
        placement: "module-scope",
      },
      title: "Register live presence on the sync engine",
    },
  ],
});
