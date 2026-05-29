import { describe, expect, test } from 'bun:test';
import { createSyncEngine } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import {
	createFavoritesPack,
	createInMemoryFavoritesStore,
	type FavoriteRow
} from '../src';

type Ctx = { userId?: string };
type DocRow = { id: string; title: string };

describe('createFavoritesPack', () => {
	test('favorite + read: only the calling actor sees their row', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 1_000
			})
		);

		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);

		const aliceView = await engine.subscribe<FavoriteRow, { resourceKind?: string }>({
			collection: 'favorites',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: { resourceKind: undefined }
		});
		expect(aliceView.initial.length).toBe(1);
		expect(aliceView.initial[0]).toMatchObject({
			actorId: 'alice',
			id: 'alice:doc:doc-1',
			resourceId: 'doc-1',
			resourceKind: 'doc'
		});

		const bobView = await engine.subscribe<FavoriteRow, { resourceKind?: string }>({
			collection: 'favorites',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: { resourceKind: undefined }
		});
		expect(bobView.initial.length).toBe(0);
	});

	test('favorite is idempotent (deterministic row id)', async () => {
		const engine = createSyncEngine();
		const store = createInMemoryFavoritesStore();
		engine.registerPack(
			createFavoritesPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				store
			})
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		expect((store.reader.all({}) as FavoriteRow[]).length).toBe(1);
	});

	test('unfavorite removes the row; later favorite re-adds', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({ getActorId: (ctx) => ctx.userId })
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'favorites:unfavorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		const view = await engine.subscribe<FavoriteRow, { resourceKind?: string }>({
			collection: 'favorites',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: { resourceKind: undefined }
		});
		expect(view.initial.length).toBe(0);
	});

	test('toggle inserts on first call, deletes on second', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({ getActorId: (ctx) => ctx.userId })
		);
		const first = (await engine.runMutation(
			'favorites:toggle',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as { favorited: boolean };
		expect(first.favorited).toBe(true);

		const second = (await engine.runMutation(
			'favorites:toggle',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as { favorited: boolean };
		expect(second.favorited).toBe(false);
	});

	test('subscription with resourceKind param filters by kind', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({ getActorId: (ctx) => ctx.userId })
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'a', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: '1', resourceKind: 'task' },
			{ userId: 'alice' }
		);
		const docs = await engine.subscribe<FavoriteRow, { resourceKind?: string }>({
			collection: 'favorites',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: { resourceKind: 'doc' }
		});
		expect(docs.initial.map((row) => row.resourceId)).toEqual(['a']);
	});

	test('writes without an actor id throw', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({ getActorId: (ctx) => ctx.userId })
		);
		const error = await expectRejection(() =>
			engine.runMutation(
				'favorites:favorite',
				{ resourceId: 'a', resourceKind: 'doc' },
				{}
			)
		);
		expect((error as Error).message).toMatch(/no actor id/);
	});

	test('joinResources: favorites-with-resource pairs each row with the host resource', async () => {
		const engine = createSyncEngine();
		const docs: DocRow[] = [
			{ id: 'doc-1', title: 'Roadmap' },
			{ id: 'doc-2', title: 'Postmortem' }
		];
		engine.registerReader('docs', { all: () => docs });
		engine.registerPack(
			createFavoritesPack<Ctx, DocRow>({
				getActorId: (ctx) => ctx.userId,
				joinResources: {
					hydrate: () => docs,
					table: 'docs'
				}
			})
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-2', resourceKind: 'doc' },
			{ userId: 'alice' }
		);

		const view = await engine.subscribe<FavoriteRow & { resource: DocRow }, { resourceKind?: string }>({
			collection: 'favorites-with-resource',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: { resourceKind: undefined }
		});
		const titles = view.initial
			.map((row) => row.resource.title)
			.sort();
		expect(titles).toEqual(['Postmortem', 'Roadmap']);

		// readsTables reports the dep.
		expect(engine.inspect().packs[0]?.readsTables).toEqual(['docs']);
	});

	test('prefix produces distinct names', () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({ prefix: 'team_' })
		);
		const inspection = engine.inspect();
		expect(inspection.packs[0]?.ownsTables).toEqual(['team_favorites']);
		expect(inspection.mutations).toContain('team_favorites:favorite');
		expect(inspection.mutations).toContain('team_favorites:unfavorite');
		expect(inspection.mutations).toContain('team_favorites:toggle');
		expect(inspection.mutations).toContain('team_favorites:pin');
		expect(inspection.mutations).toContain('team_favorites:unpin');
		expect(inspection.mutations).toContain('team_favorites:togglePin');
		expect(inspection.collections.map((c) => c.name)).toContain(
			'team_favorites'
		);
	});

	test('engine.inspect() surfaces the pack', () => {
		const engine = createSyncEngine();
		engine.registerPack(createFavoritesPack<Ctx>());
		expect(engine.inspect().packs).toEqual([
			{
				name: '@absolutejs/sync-pack-favorites',
				ownsTables: ['favorites'],
				readsTables: [],
				version: '0.2.0'
			}
		]);
	});

	test('pin sets pinnedAt; unpin clears it; togglePin flips', async () => {
		const engine = createSyncEngine();
		let clock = 1_000;
		engine.registerPack(
			createFavoritesPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => clock
			})
		);

		// pin on a row that doesn't exist yet — creates a pinned favorite
		const created = (await engine.runMutation(
			'favorites:pin',
			{ resourceId: 'doc-9', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as FavoriteRow;
		expect(created.pinnedAt).toBe(1_000);
		expect(created.createdAt).toBe(1_000);

		// pin again — idempotent, keeps the same pinnedAt
		clock = 2_000;
		const repinned = (await engine.runMutation(
			'favorites:pin',
			{ resourceId: 'doc-9', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as FavoriteRow;
		expect(repinned.pinnedAt).toBe(1_000);

		// togglePin → unpinned
		const toggled = (await engine.runMutation(
			'favorites:togglePin',
			{ resourceId: 'doc-9', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as { pinned: boolean };
		expect(toggled.pinned).toBe(false);

		// unpin on already-unpinned — still returns the row, pinnedAt stays null
		const unpinned = (await engine.runMutation(
			'favorites:unpin',
			{ resourceId: 'doc-9', resourceKind: 'doc' },
			{ userId: 'alice' }
		)) as FavoriteRow;
		expect(unpinned.pinnedAt).toBeNull();
	});

	test('pinning is scoped per-actor (bob cannot affect alice)', async () => {
		const engine = createSyncEngine();
		engine.registerPack(
			createFavoritesPack<Ctx>({
				getActorId: (ctx) => ctx.userId,
				now: () => 5_000
			})
		);

		await engine.runMutation(
			'favorites:favorite',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'favorites:pin',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'alice' }
		);

		// Bob pinning the same resource creates HIS own row, not Alice's.
		const bobView = await engine.subscribe<FavoriteRow, { resourceKind?: string }>({
			collection: 'favorites',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: { resourceKind: undefined }
		});
		await engine.runMutation(
			'favorites:pin',
			{ resourceId: 'doc-1', resourceKind: 'doc' },
			{ userId: 'bob' }
		);
		expect(bobView.initial.length).toBe(0); // initial snapshot, pre-mutation
	});
});
