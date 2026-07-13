import { defineManifest, toolFactory } from '@absolutejs/manifest';
import type { SyncPack } from '@absolutejs/sync/engine';
import { Type } from '@sinclair/typebox';
import type { CountersPackConfig } from './index';

const tool = toolFactory<SyncPack>();

/* Serializable subset of CountersPackConfig: prefix only. `counters` (the
 * compute functions) and getActorId are function-valued → wiring concerns. */
export const manifest = defineManifest<CountersPackConfig, SyncPack>()({
	contract: 1,
	identity: {
		accent: '#06b6d4',
		category: 'sync',
		description:
			'Read-set-tracked live counters for `@absolutejs/sync` — one `engine.registerPack(createCountersPack(...))` turns each compute function into a reactive query that re-runs only when the rows it actually read change. No manual invalidation, no polling: subscribe to `counter:<name>` and the number stays current.',
		docsUrl: 'https://github.com/absolutejs/sync-packs/tree/main/counters',
		name: '@absolutejs/sync-pack-counters',
		tagline: 'Live counts and badges that update themselves.'
	},
	settings: Type.Object({
		prefix: Type.Optional(
			Type.String({
				description: 'Name prefix for the pack’s counter queries.',
				title: 'Name prefix'
			})
		)
	}),
	tools: {
		pack_surface: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'List the live counters this pack registers on the sync engine.',
			handler: (_input, pack) =>
				JSON.stringify({
					counters: (pack.reactiveQueries ?? []).map(
						(query) => query.name
					),
					name: pack.name,
					version: pack.version
				}),
			input: Type.Object({})
		})
	},
	wiring: [
		{
			description:
				'Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding. Each counter becomes the reactive query counter:<name>.',
			id: 'default',
			server: {
				code: [
					'engine.registerPack(createCountersPack({',
					'\tcounters: {',
					'\t\t// TODO: a counter is a compute over tracked ctx.db reads, e.g.',
					"\t\t// openTasks: async ({ ctx, db }) => (await db.where('tasks', { status: 'open' })).length",
					'\t},',
					'\t...${settings}',
					'}));'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/sync-pack-counters',
						names: ['createCountersPack']
					}
				],
				placement: 'module-scope'
			},
			title: 'Register live counters on the sync engine'
		}
	]
});
