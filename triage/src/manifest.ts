import { defineManifest, toolFactory } from "@absolutejs/manifest";
import type { SyncPack } from "@absolutejs/sync/engine";
import { Type } from "@sinclair/typebox";
import type { TriagePackConfig } from "./index";

const tool = toolFactory<SyncPack>();

/* Serializable subset of TriagePackConfig: prefix, maxBulkSize, wakeCron.
 * getActorId / store / now are function-or-instance-valued → wiring
 * concerns. */
export const manifest = defineManifest<TriagePackConfig, SyncPack>()({
  contract: 2,
  identity: {
    accent: "#0ea5e9",
    category: "sync",
    description:
      "Per-actor triage pack for `@absolutejs/sync` — one `engine.registerPack(createTriagePack(...))` adds unread/seen, snooze, dismiss, and mute over any host resource, with an owner-scoped live list. Dismiss sticks across new activity; snooze resurfaces as soon as the other side acts, so nothing important stays hidden behind a timer.",
    docsUrl: "https://github.com/absolutejs/sync-packs/tree/main/triage",
    name: "@absolutejs/sync-pack-triage",
    tagline: "Give every queue an inbox people can actually clear.",
  },
  settings: Type.Object({
    maxBulkSize: Type.Optional(
      Type.Number({
        description:
          "Largest number of resources one bulk call may change at once.",
        title: "Bulk limit",
      }),
    ),
    prefix: Type.Optional(
      Type.String({
        description:
          "Name prefix for the pack’s table, collection, and mutations.",
        title: "Name prefix",
      }),
    ),
    wakeCron: Type.Optional(
      Type.String({
        description:
          "Cron pattern for the sweep that returns expired snoozes to the active list.",
        title: "Snooze sweep schedule",
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
        "What this triage pack adds to the sync engine: the table it owns, its collection, its mutations, and its snooze sweep.",
      handler: (_input, pack) =>
        JSON.stringify({
          collections: (pack.collections ?? []).map(
            (collection) => collection.name,
          ),
          mutations: (pack.mutations ?? []).map((mutation) => mutation.name),
          name: pack.name,
          ownsTables: pack.ownsTables,
          schedules: (pack.schedules ?? []).map((schedule) => schedule.name),
          version: pack.version,
        }),
      input: Type.Object({}),
    }),
  },
  wiring: [
    {
      description:
        "Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding.",
      id: "default",
      server: {
        code: [
          "// getActorId defaults to reading ctx.userId. Pass a store to back",
          "// triage with your own database instead of the in-memory default.",
          "engine.registerPack(createTriagePack(${settings}));",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/sync-pack-triage",
            names: ["createTriagePack"],
          },
        ],
        placement: "module-scope",
      },
      title: "Register triage on the sync engine",
    },
  ],
});
