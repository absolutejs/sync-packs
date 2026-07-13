import { defineManifest, toolFactory } from '@absolutejs/manifest';
import type { SyncPack } from '@absolutejs/sync/engine';
import { Type } from '@sinclair/typebox';
import type { CommentsPackConfig } from './index';

const tool = toolFactory<SyncPack>();

/* Serializable subset of CommentsPackConfig: prefix, maxDepth, and the
 * reactions / search feature blocks. getActorId / canReadResource /
 * canModerate / store / now / newId / joinUsers are function-or-instance-
 * valued → wiring concerns; bodyCrdt is the sync/crdt-adapter slot. */
export const manifest = defineManifest<CommentsPackConfig, SyncPack>()({
	contract: 1,
	identity: {
		accent: '#f59e0b',
		category: 'sync',
		description:
			'Threaded comments pack for `@absolutejs/sync` — one `engine.registerPack(createCommentsPack(...))` adds per-resource comment threads with author/moderator delete gates, the host’s own ACL injected via `canReadResource`, optional emoji reactions, optional live full-text search over bodies, an optional author-join collection, and optional CRDT comment bodies (concurrent edits merge instead of clobbering).',
		docsUrl: 'https://github.com/absolutejs/sync-packs/tree/main/comments',
		name: '@absolutejs/sync-pack-comments',
		tagline: 'Let people comment on anything — threads, live.'
	},
	settings: Type.Object({
		maxDepth: Type.Optional(
			Type.Integer({
				description:
					'How deep reply threads can nest (top level is 0). Default 8.',
				minimum: 0,
				title: 'Reply depth limit'
			})
		),
		prefix: Type.Optional(
			Type.String({
				description:
					'Name prefix for the pack’s tables, collections, and mutations — set one when running several comments packs on the same engine.',
				title: 'Name prefix'
			})
		),
		reactions: Type.Optional(
			Type.Object(
				{
					allowedEmojis: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Which emojis people can react with. Leave empty to allow any.',
							title: 'Allowed emojis'
						})
					)
				},
				{
					description:
						'Turn on emoji reactions: one tap per person per emoji per comment, live counts.',
					title: 'Reactions'
				}
			)
		),
		search: Type.Optional(
			Type.Object(
				{
					topK: Type.Optional(
						Type.Integer({
							description:
								'How many best-matching comments a search returns.',
							minimum: 1,
							title: 'Results per search'
						})
					)
				},
				{
					description:
						'Turn on live full-text search over comment bodies — results re-rank as comments change.',
					title: 'Comment search'
				}
			)
		)
	}),
	slots: {
		bodyCrdt: {
			configPath: 'bodyCrdt',
			contract: 'sync/crdt-adapter',
			description:
				'Optional: merge simultaneous edits to a comment body instead of overwriting',
			known: [
				'@absolutejs/sync#rga-text',
				'@absolutejs/sync-yjs',
				'@absolutejs/sync-automerge',
				'@absolutejs/sync-loro'
			]
		}
	},
	tools: {
		pack_surface: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'What this comments pack adds to the sync engine: owned tables, read tables (author join), collections (including search/join), and mutations.',
			handler: (_input, pack) =>
				JSON.stringify({
					collections: [
						...(pack.collections ?? []).map(
							(collection) => collection.name
						),
						...(pack.joinCollections ?? []).map(
							(collection) => collection.name
						),
						...(pack.searchCollections ?? []).map(
							(collection) => collection.name
						)
					],
					mutations: (pack.mutations ?? []).map(
						(mutation) => mutation.name
					),
					name: pack.name,
					ownsTables: pack.ownsTables,
					readsTables: pack.readsTables ?? [],
					version: pack.version
				}),
			input: Type.Object({})
		})
	},
	wiring: [
		{
			description:
				'Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding. The host’s ACL gates every read — the pack never duplicates it.',
			id: 'default',
			server: {
				code: [
					'engine.registerPack(createCommentsPack({',
					'\tbodyCrdt: ${slot.bodyCrdt},',
					'\t// TODO: your ACL — who can read comments on this resource?',
					'\tcanReadResource: (resourceId, ctx) => true,',
					'\t// getActorId defaults to (ctx) => ctx.userId; add canModerate for',
					'\t// admin deletes and joinUsers for a comments-with-author collection.',
					'\t...${settings}',
					'}));'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/sync-pack-comments',
						names: ['createCommentsPack']
					}
				],
				placement: 'module-scope'
			},
			title: 'Register threaded comments on the sync engine'
		}
	]
});
