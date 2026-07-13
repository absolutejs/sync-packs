import { defineManifest, toolFactory } from '@absolutejs/manifest';
import type { SyncPack } from '@absolutejs/sync/engine';
import { Type } from '@sinclair/typebox';
import type { DigestPackConfig } from './index';

const tool = toolFactory<SyncPack>();

/* Serializable subset of DigestPackConfig: prefix, cron, back-pressure and
 * frequency caps, dryRun. send / buildDigest / listActors / getActorId /
 * retry / store / now / onActorFailure / onActorPreview are function-or-
 * instance-valued → wiring concerns (the pack is transport-agnostic on
 * purpose — delivery goes through the host's sender, e.g.
 * @absolutejs/dispatch). */
export const manifest = defineManifest<DigestPackConfig, SyncPack>()({
	contract: 1,
	identity: {
		accent: '#a855f7',
		category: 'sync',
		description:
			'Scheduled per-actor digest pack for `@absolutejs/sync` — one `engine.registerPack(createDigestPack(...))` adds a cron-fired schedule that iterates your actors, builds each one’s digest since their personal cursor, and hands it to your sender (the pack owns cursors and cadence, never transport). Per-actor failures are isolated; `dryRun` previews what would send.',
		docsUrl: 'https://github.com/absolutejs/sync-packs/tree/main/digest',
		name: '@absolutejs/sync-pack-digest',
		tagline: 'Send everyone a personal summary email on a schedule.'
	},
	settings: Type.Object({
		cron: Type.Optional(
			Type.String({
				description:
					'When digests fire (cron syntax). Default Mondays at 08:00.',
				examples: ['0 8 * * 1'],
				title: 'Digest schedule'
			})
		),
		dryRun: Type.Optional(
			Type.Boolean({
				description:
					'Build digests but don’t send or advance cursors — preview what the next fire would deliver.',
				title: 'Preview mode'
			})
		),
		maxActorsPerFire: Type.Optional(
			Type.Integer({
				description:
					'How many people are processed per fire; the rest wait for the next one. Default 1000.',
				minimum: 1,
				title: 'People per fire'
			})
		),
		minHoursBetweenDigests: Type.Optional(
			Type.Number({
				description:
					'Someone whose last digest is fresher than this is skipped. Default 168 (one week).',
				minimum: 0,
				title: 'Minimum hours between digests'
			})
		),
		prefix: Type.Optional(
			Type.String({
				description:
					'Name prefix for the pack’s cursor table, collection, and schedule.',
				title: 'Name prefix'
			})
		)
	}),
	tools: {
		pack_surface: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'What this digest pack adds to the sync engine: the cursor table it owns, its collection, and the digest schedule with its cron pattern.',
			handler: (_input, pack) =>
				JSON.stringify({
					collections: (pack.collections ?? []).map(
						(collection) => collection.name
					),
					name: pack.name,
					ownsTables: pack.ownsTables,
					schedules: (pack.schedules ?? []).map((schedule) => ({
						name: schedule.name,
						pattern: schedule.pattern
					})),
					version: pack.version
				}),
			input: Type.Object({})
		})
	},
	wiring: [
		{
			description:
				'Rides @absolutejs/sync’s engine recipe: `engine` is its module-scope binding (mount the scheduled plugin so cron patterns actually fire). Delivery composes with @absolutejs/dispatch or any sender.',
			id: 'default',
			server: {
				code: [
					'engine.registerPack(createDigestPack({',
					'\t// TODO: what goes in one person’s digest since their last one.',
					'\tbuildDigest: async (actorId, since) => null, // null skips silently',
					'\t// TODO: who receives digests (your data layer is the source of truth).',
					'\tlistActors: () => [],',
					'\t// TODO: deliver it — e.g. dispatcher.email({ to, subject, text }).',
					'\tsend: async (message) => {},',
					'\t...${settings}',
					'}));'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/sync-pack-digest',
						names: ['createDigestPack']
					}
				],
				placement: 'module-scope'
			},
			title: 'Register scheduled digests on the sync engine'
		}
	]
});
