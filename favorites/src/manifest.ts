import { defineManifest, toolFactory } from "@absolutejs/manifest";
import type { SyncPack } from "@absolutejs/sync/engine";
import { Type } from "@sinclair/typebox";
import type { FavoritesPackConfig } from "./index";

const tool = toolFactory<SyncPack>();

/* Serializable subset of FavoritesPackConfig: prefix only. getActorId /
 * store / now / joinResources are function-or-instance-valued → wiring
 * concerns. */
export const manifest = defineManifest<FavoritesPackConfig, SyncPack>()({
  contract: 2,
  identity: {
    accent: "#eab308",
    category: "sync",
    description:
      "Per-actor saved-resources pack for `@absolutejs/sync` — one `engine.registerPack(createFavoritesPack(...))` adds favorite/unfavorite/pin mutations and an owner-scoped live list, with deterministic row ids for idempotent toggling and an optional join collection that pairs each favorite with its host resource row.",
    docsUrl: "https://github.com/absolutejs/sync-packs/tree/main/favorites",
    name: "@absolutejs/sync-pack-favorites",
    tagline: "Let members save and pin their favorite things.",
  },
  settings: Type.Object({
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
        "What this favorites pack adds to the sync engine: the table it owns, its collections (including any resource join), and its mutations.",
      handler: (_input, pack) =>
        JSON.stringify({
          collections: [
            ...(pack.collections ?? []).map((collection) => collection.name),
            ...(pack.joinCollections ?? []).map(
              (collection) => collection.name,
            ),
          ],
          mutations: (pack.mutations ?? []).map((mutation) => mutation.name),
          name: pack.name,
          ownsTables: pack.ownsTables,
          readsTables: pack.readsTables ?? [],
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
          "// getActorId defaults to (ctx) => ctx.userId; add joinResources for a",
          "// favorites-with-resource live collection.",
          "engine.registerPack(createFavoritesPack(${settings}));",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/sync-pack-favorites",
            names: ["createFavoritesPack"],
          },
        ],
        placement: "module-scope",
      },
      title: "Register favorites on the sync engine",
    },
  ],
});
