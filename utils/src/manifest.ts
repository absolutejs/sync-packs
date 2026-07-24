import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

/* Pure helper library (no factory, no config, no runtime instance):
 * settings-empty manifest for catalog identity plus one wiring recipe
 * showing the store + actor helpers the official packs are built from. */
export const manifest = defineManifest<Record<never, never>>()({
  contract: 2,
  identity: {
    accent: "#64748b",
    category: "sync",
    description:
      "Shared helpers extracted from the official `@absolutejs/sync` packs: `resolveActor` / `defaultGetActorId` (actor identity from ctx), `requireRowOwner` / `requireOwnerOrModerator` (mutation guards), and `createInMemoryStore` (the default keyed row store). Use them to build your own pack without restating the patterns.",
    docsUrl: "https://github.com/absolutejs/sync-packs/tree/main/utils",
    name: "@absolutejs/sync-pack-utils",
    tagline: "Building blocks for writing your own sync packs.",
  },
  settings: Type.Object({}),
  wiring: [
    {
      description:
        "The helpers the official packs are built from — actor resolution, ownership guards, and the default in-memory row store.",
      id: "default",
      server: {
        code: [
          "// A custom pack usually starts with a keyed store and an actor guard:",
          "const rows = createInMemoryStore<{ id: string; actorId: string }>();",
          "// const actorId = resolveActor(getActorId, ctx); // throws when unauthenticated",
          "// requireRowOwner(row, actorId);                 // gate updates/deletes",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/sync-pack-utils",
            names: ["createInMemoryStore", "requireRowOwner", "resolveActor"],
          },
        ],
        placement: "module-scope",
      },
      title: "Helpers for a hand-rolled sync pack",
    },
  ],
});
