import { defineManifest, toolFactory } from '@absolutejs/manifest';
import type { SyncPack } from '@absolutejs/sync/engine';
import { Type } from '@sinclair/typebox';
import type { MentionsPackConfig } from './index';

const tool = toolFactory<SyncPack>();

/* Serializable subset of MentionsPackConfig: prefix + snippetRadius.
 * pattern is a RegExp; getActorId / resolveActorId / onMention / store /
 * now are function-or-instance-valued → wiring concerns. */
export const manifest = defineManifest<MentionsPackConfig, SyncPack>()({
	contract: 1,
	identity: {
		accent: '#3b82f6',
		category: 'sync',
		description:
			'@mention parser pack for `@absolutejs/sync` — one `engine.registerPack(createMentionsPack(...))` adds a record mutation that extracts @usernames from a posted body, writes one row per mentioned actor (with a context snippet), and fires an `onMention` hook that composes with the notifications pack. Owner-scoped live reads show each member their mentions.',
		docsUrl: 'https://github.com/absolutejs/sync-packs/tree/main/mentions',
		name: '@absolutejs/sync-pack-mentions',
		tagline: 'Turn @mentions into rows, alerts, and inbox items.'
	},
	settings: Type.Object({
		prefix: Type.Optional(
			Type.String({
				description:
					'Name prefix for the pack’s table, collection, and mutations.',
				title: 'Name prefix'
			})
		),
		snippetRadius: Type.Optional(
			Type.Integer({
				description:
					'How many characters of surrounding text are kept with each mention. Default 30 each side.',
				minimum: 0,
				title: 'Context snippet size'
			})
		)
	}),
	tools: {
		pack_surface: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'What this mentions pack adds to the sync engine: the table it owns, its collection, and its mutations.',
			handler: (_input, pack) =>
				JSON.stringify({
					collections: (pack.collections ?? []).map(
						(collection) => collection.name
					),
					mutations: (pack.mutations ?? []).map(
						(mutation) => mutation.name
					),
					name: pack.name,
					ownsTables: pack.ownsTables,
					version: pack.version
				}),
			input: Type.Object({})
		})
	},
	wiring: [
		{
			description:
				'Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding. Compose with the notifications pack inside onMention.',
			id: 'default',
			server: {
				code: [
					'engine.registerPack(createMentionsPack({',
					'\t// TODO: map a matched @username to an actor id (undefined skips it).',
					'\tresolveActorId: (username, ctx) => username,',
					'\t// TODO: alert the mentioned member — e.g. run the notifications',
					"\t// pack's notify mutation from your app code.",
					'\tonMention: async (args, ctx, actions) => {},',
					'\t...${settings}',
					'}));'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/sync-pack-mentions',
						names: ['createMentionsPack']
					}
				],
				placement: 'module-scope'
			},
			title: 'Register @mention tracking on the sync engine'
		}
	]
});
