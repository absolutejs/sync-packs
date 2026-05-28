import { describe, expect, test } from 'bun:test';
import { createSyncEngine, defineMutation } from '@absolutejs/sync/engine';
import { expectRejection } from '@absolutejs/sync/testing';
import { createCountersPack, type CounterRow } from '../src';

type Ctx = { userId?: string };
type Task = { id: string; title: string; done: boolean };

const makeTasksEngine = () => {
	const tasks = new Map<string, Task>();
	const engine = createSyncEngine();
	engine.registerReader('tasks', { all: () => [...tasks.values()] });
	engine.registerWriter<Task>('tasks', {
		delete: (row) => {
			tasks.delete((row as { id: string }).id);
		},
		insert: (row) => {
			tasks.set(row.id, row);
			return row;
		},
		update: (row) => {
			const prior = tasks.get(row.id);
			const merged = { ...(prior ?? {}), ...row } as Task;
			tasks.set(row.id, merged);
			return merged;
		}
	});
	engine.registerMutation(
		defineMutation({
			handler: async (args: Task, _ctx, actions) =>
				actions.insert('tasks', args),
			name: 'addTask'
		})
	);
	engine.registerMutation(
		defineMutation({
			handler: async (args: { id: string; done: boolean }, _ctx, actions) =>
				actions.update('tasks', args),
			name: 'setDone'
		})
	);
	return { engine, tasks };
};

describe('createCountersPack', () => {
	test('counter emits initial value on subscribe', async () => {
		const { engine } = makeTasksEngine();
		await engine.runMutation(
			'addTask',
			{ done: false, id: 'a', title: 'a' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'addTask',
			{ done: true, id: 'b', title: 'b' },
			{ userId: 'alice' }
		);

		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					openTasks: async ({ db }) =>
						(await db.all<Task>('tasks')).filter(
							(task) => !task.done
						).length
				},
				getActorId: (ctx) => ctx.userId
			})
		);

		const subscription = await engine.subscribe<CounterRow>({
			collection: 'counter:openTasks',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: undefined
		});
		expect(subscription.initial.length).toBe(1);
		expect(subscription.initial[0]).toMatchObject({
			id: 'openTasks',
			key: 'openTasks',
			value: 1
		});
	});

	test('counter re-emits when a read table changes (read-set tracking)', async () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					openTasks: async ({ db }) =>
						(await db.all<Task>('tasks')).filter(
							(task) => !task.done
						).length
				},
				getActorId: (ctx) => ctx.userId
			})
		);

		// Subscribe, then add two open tasks and toggle one — assert the
		// counter pushed the new value each time.
		const values: number[] = [];
		const sub = await engine.subscribe<CounterRow>({
			collection: 'counter:openTasks',
			ctx: { userId: 'alice' },
			onDiff: (diff) => {
				for (const row of [...diff.added, ...diff.changed]) {
					values.push((row as CounterRow).value);
				}
			},
			params: undefined
		});
		expect(sub.initial[0]?.value).toBe(0);

		await engine.runMutation(
			'addTask',
			{ done: false, id: 'a', title: 'a' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'addTask',
			{ done: false, id: 'b', title: 'b' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'setDone',
			{ done: true, id: 'a' },
			{ userId: 'alice' }
		);
		// 0 (initial) → 1 → 2 → 1
		expect(values).toEqual([1, 2, 1]);
	});

	test('per-actor counter uses ctx in the compute', async () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					myTasks: async ({ db, ctx }) => {
						const tasks = await db.all<Task & { ownerId: string }>(
							'tasks'
						);
						return tasks.filter((task) => task.ownerId === ctx.userId)
							.length;
					}
				},
				getActorId: (ctx) => ctx.userId
			})
		);
		await engine.runMutation(
			'addTask',
			{ done: false, id: 'a', ownerId: 'alice', title: 'a' },
			{ userId: 'alice' }
		);
		await engine.runMutation(
			'addTask',
			{ done: false, id: 'b', ownerId: 'bob', title: 'b' },
			{ userId: 'bob' }
		);

		const aliceView = await engine.subscribe<CounterRow>({
			collection: 'counter:myTasks',
			ctx: { userId: 'alice' },
			onDiff: () => {},
			params: undefined
		});
		const bobView = await engine.subscribe<CounterRow>({
			collection: 'counter:myTasks',
			ctx: { userId: 'bob' },
			onDiff: () => {},
			params: undefined
		});
		expect(aliceView.initial[0]?.value).toBe(1);
		expect(bobView.initial[0]?.value).toBe(1);
	});

	test('multiple counters: each is its own collection with independent re-runs', async () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					doneTasks: async ({ db }) =>
						(await db.all<Task>('tasks')).filter(
							(task) => task.done
						).length,
					openTasks: async ({ db }) =>
						(await db.all<Task>('tasks')).filter(
							(task) => !task.done
						).length
				},
				getActorId: (ctx) => ctx.userId
			})
		);
		const collections = engine
			.inspect()
			.collections.map((collection) => collection.name);
		expect(collections).toContain('counter:openTasks');
		expect(collections).toContain('counter:doneTasks');
	});

	test('default authorize rejects subscriptions without an actor id', async () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					openTasks: async ({ db }) =>
						(await db.all<Task>('tasks')).filter(
							(task) => !task.done
						).length
				},
				getActorId: (ctx) => ctx.userId
			})
		);
		const error = await expectRejection(() =>
			engine.subscribe<CounterRow>({
				collection: 'counter:openTasks',
				ctx: {}, // no userId
				onDiff: () => {},
				params: undefined
			})
		);
		expect((error as Error).message).toMatch(/Not authorized/);
	});

	test('per-counter authorize override allows global counters', async () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					totalTasks: {
						authorize: () => true,
						compute: async ({ db }) =>
							(await db.all<Task>('tasks')).length
					}
				}
			})
		);
		// Anonymous ctx is fine for this counter.
		const view = await engine.subscribe<CounterRow>({
			collection: 'counter:totalTasks',
			ctx: {},
			onDiff: () => {},
			params: undefined
		});
		expect(view.initial[0]?.value).toBe(0);
	});

	test('prefix produces distinct collection names', () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					a: { authorize: () => true, compute: () => 1 }
				},
				prefix: 'team_'
			})
		);
		const names = engine
			.inspect()
			.collections.map((collection) => collection.name);
		expect(names).toContain('team_counter:a');
	});

	test('engine.inspect() surfaces the pack with empty owns/reads tables', () => {
		const { engine } = makeTasksEngine();
		engine.registerPack(
			createCountersPack<Ctx>({
				counters: {
					noOp: { authorize: () => true, compute: () => 0 }
				}
			})
		);
		expect(engine.inspect().packs).toEqual([
			{
				name: '@absolutejs/sync-pack-counters',
				ownsTables: [],
				readsTables: [],
				version: '0.1.0'
			}
		]);
	});
});
