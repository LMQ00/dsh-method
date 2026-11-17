#!/usr/bin/env node
/**
 * 纯逻辑自测：状态落盘、字段完整性校验、进度更新。跑法：node selftest.mjs
 *
 * 只测不依赖宿主的模块（store.js / schema.js）。工具、命令、提示词段、面板要在真实 dsh 里验。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, 'tmp');
mkdirSync(tempRoot, { recursive: true });
// 镜像文件写到临时目录，别碰真实的 $DSH_HOME。
process.env.DSH_HOME = mkdtempSync(join(tempRoot, 'dsh-home-'));

const store = await import('./store.js');
const schema = await import('./schema.js');

let passed = 0;
let attempted = 0;
const failures = [];

/** 一个断言。 */
function check(name, fn) {
	attempted += 1;
	try {
		fn();
		passed += 1;
	} catch (error) {
		failures.push(`${name}: ${error?.message ?? error}`);
	}
}

/** 断言相等。 */
function equal(actual, expected, what) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${what}：期望 ${b}，实际 ${a}`);
}

/** 断言抛错，且错误信息含指定片段。 */
async function rejects(name, fn, fragment) {
	attempted += 1;
	try {
		await fn();
		failures.push(`${name}: 没有抛错`);
	} catch (error) {
		if (!String(error.message).includes(fragment)) {
			failures.push(`${name}: 错误信息里没有「${fragment}」，实际「${error.message}」`);
			return;
		}
		passed += 1;
	}
}

/** 建一个带 .git 的临时项目目录。 */
function makeProject(label) {
	const dir = mkdtempSync(join(tempRoot, `${label}-`));
	mkdirSync(join(dir, '.git'), { recursive: true });
	return dir;
}

/* ---------------- store ---------------- */

check('空状态字段齐全', () => {
	const state = store.defaultState();
	equal(state.enabled, false, 'enabled');
	equal(state.selectedChart, null, 'selectedChart');
	equal(state.nodes, {}, 'nodes');
	equal(state.revision, 0, 'revision');
});

check('状态往返不丢字段', () => {
	const dir = makeProject('roundtrip');
	const base = store.defaultState();
	const { state } = store.writeState(dir, {
		...base,
		enabled: true,
		selectedChart: 'plan-a',
		stage: '实现中',
		next: '等回报',
		members: [{ name: 'researcher', role: '查源码', status: '进行中' }],
		nodes: { n1: { title: '查源码', status: '完成' } },
		charts: { 'plan-a': { id: 'plan-a', name: '方案 A', nodes: [{ id: 'n1', title: '查源码' }], edges: [] } },
	});
	equal(state.revision, 1, '第一次写的 revision');
	const read = store.readState(dir);
	equal(read.broken, false, 'broken');
	equal(read.state.stage, '实现中', 'stage');
	equal(read.state.members[0].status, '进行中', 'member status');
	equal(store.flattenChart(read.state).nodes[0].status, '完成', '节点状态');
	rmSync(dir, { recursive: true, force: true });
});

check('损坏的状态文件先备份再当空状态', () => {
	const dir = makeProject('broken');
	const path = store.resolveStatePath(dir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, '{ 这不是 JSON', 'utf8');
	const read = store.readState(dir);
	equal(read.broken, true, 'broken');
	equal(read.state.enabled, false, '退回空状态');
	const backups = readdirSync(dirname(path)).filter((name) => name.endsWith('.bad'));
	equal(backups.length, 1, '备份文件数');
	rmSync(dir, { recursive: true, force: true });
});

check('状态写盘留下自忽略的 .gitignore', () => {
	const dir = makeProject('ignore');
	store.writeState(dir, store.defaultState());
	const ignore = readFileSync(join(dir, '.orchestrate', '.gitignore'), 'utf8');
	equal(ignore.trim(), '*', '.gitignore 内容');
	rmSync(dir, { recursive: true, force: true });
});

check('镜像文件写进 DSH_HOME', () => {
	const dir = makeProject('mirror');
	store.writeState(dir, {
		...store.defaultState(),
		enabled: true,
		selectedChart: 'plan-a',
		nodes: { n1: { title: '一', status: '完成' } },
		charts: { 'plan-a': { id: 'plan-a', name: 'A', nodes: [{ id: 'n1', title: '一' }], edges: [] } },
	});
	const mirror = JSON.parse(readFileSync(store.resolveMirrorPath(), 'utf8'));
	equal(mirror.cwd, dir, '镜像里的项目目录');
	equal(mirror.nodes[0].status, '完成', '镜像里的节点状态');
	rmSync(dir, { recursive: true, force: true });
});

check('方案存档能列出来', () => {
	const dir = makeProject('archive');
	store.archiveChart(dir, { id: 'plan-a', name: 'A', nodes: [{ id: 'n1', title: '一' }], edges: [] });
	store.archiveChart(dir, { id: 'plan-b', name: 'B', nodes: [{ id: 'n1', title: '一' }], edges: [] });
	equal(store.listCharts(dir), ['plan-a', 'plan-b'], '存档列表');
	rmSync(dir, { recursive: true, force: true });
});

/* ---------------- chart_submit 校验 ---------------- */

const goodSubmit = () => ({
	plan: { id: 'plan-a', name: '方案 A' },
	nodes: [{ id: 'n1', title: '查源码' }, { id: 'n2', title: '写模块' }],
	edges: [{ from: 'n1', to: 'n2' }],
});

check('合法方案被接受（含单节点无边）', () => {
	const chart = schema.validateSubmission(goodSubmit());
	equal(chart.id, 'plan-a', 'id');
	equal(chart.nodes.length, 2, '节点数');
	const single = schema.validateSubmission({ plan: { id: 'plan-b', name: 'B' }, nodes: [{ id: 'n1', title: '一步' }], edges: [] });
	equal(single.edges.length, 0, '单节点无连线');
	// 有环也收：结构不归插件管。
	const cyclic = schema.validateSubmission({
		plan: { id: 'plan-c', name: 'C' },
		nodes: [{ id: 'n1', title: '一' }, { id: 'n2', title: '二' }],
		edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }],
	});
	equal(cyclic.edges.length, 2, '环也照收');
});

await rejects('缺 plan.name 时报错点名', () => schema.validateSubmission({ plan: { id: 'plan-a' }, nodes: [{ id: 'n1', title: '一' }], edges: [] }), 'plan.name');
await rejects('连线指向不存在的节点', () => schema.validateSubmission({
	plan: { id: 'plan-a', name: 'A' },
	nodes: [{ id: 'n1', title: '一' }],
	edges: [{ from: 'n1', to: 'n9' }],
}), 'edges[0].to');
await rejects('nodes 为空', () => schema.validateSubmission({ plan: { id: 'plan-a', name: 'A' }, nodes: [], edges: [] }), 'nodes');
await rejects('方案 id 不合法', () => schema.validateSubmission({ plan: { id: 'Plan A', name: 'A' }, nodes: [{ id: 'n1', title: '一' }], edges: [] }), 'plan.id');
await rejects('节点 id 重复', () => schema.validateSubmission({
	plan: { id: 'plan-a', name: 'A' },
	nodes: [{ id: 'n1', title: '一' }, { id: 'n1', title: '二' }],
	edges: [],
}), '重复');

/* ---------------- chart_update 校验 ---------------- */

/** 建一份已有方案的初始状态。 */
function stateWithChart() {
	return {
		...store.defaultState(),
		enabled: true,
		nodes: { n1: { title: '一', status: '待办' }, n2: { title: '二', status: '待办' } },
		charts: { 'plan-a': { id: 'plan-a', name: 'A', nodes: [{ id: 'n1', title: '一' }, { id: 'n2', title: '二' }], edges: [{ from: 'n1', to: 'n2' }] } },
	};
}

check('选中图 + 点亮节点', () => {
	const first = schema.applyUpdate({ selectedChart: 'plan-a' }, stateWithChart());
	equal(first.state.selectedChart, 'plan-a', '选中图');
	const second = schema.applyUpdate({ nodes: { n1: { status: '完成' } }, stage: '实现中', next: '等 n2', members: [{ name: 'coder' }] }, first.state);
	equal(second.state.nodes.n1.status, '完成', '节点状态');
	equal(second.state.members[0].status, '待办', '成员默认状态');
	equal(second.state.stage, '实现中', 'stage');
});

await rejects('非法节点状态', () => schema.applyUpdate({ nodes: { n1: { status: '跑了' } } }, { ...stateWithChart(), selectedChart: 'plan-a' }), 'nodes.n1.status');
await rejects('节点 id 不在选中图里', () => schema.applyUpdate({ nodes: { n9: { status: '完成' } } }, { ...stateWithChart(), selectedChart: 'plan-a' }), 'nodes.n9');
await rejects('没选图就改节点', () => schema.applyUpdate({ nodes: { n1: { status: '完成' } } }, stateWithChart()), '还没选中方案图');
await rejects('选不存在的方案', () => schema.applyUpdate({ selectedChart: 'plan-z' }, stateWithChart()), 'selectedChart');
await rejects('一个字段都没给', () => schema.applyUpdate({}, stateWithChart()), '至少给一个');


/* ---------------- 宿主接线（假 ctx） ---------------- */

const plugin = await import('./index.js');

/**
 * 造一个能装下插件注册物的假 ctx。
 * @returns {object} { ctx, tools, commands, sections, listeners, routes }
 */
function makeContext() {
	const tools = new Map();
	const commands = [];
	const sections = [];
	const listeners = new Map();
	const routes = [];
	const projections = new Map();
	const ctx = {
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
			},
			get(name) {
				return tools.get(name);
			},
		},
		systemPrompt: {
			section(definition) {
				sections.push(definition);
			},
			getSectionOrder: () => 500,
		},
		sessionProjections: {
			register(definition) {
				projections.set(definition.key, definition);
			},
			stateOf(session) {
				return session.projected;
			},
		},
		on(event, listener) {
			const key = typeof event === 'string' ? event : '';
			if (!listeners.has(key)) listeners.set(key, []);
			listeners.get(key).push(listener);
		},
		effect(fn) {
			fn();
		},
		inject(services, callback) {
			if (services.includes('commands')) {
				callback({ commands: { register: (definition) => commands.push(definition) } });
			}
			if (services.includes('connection')) {
				callback({ connection: { fetch: { register: (route) => routes.push(route) } } });
			}
		},
	};
	return { ctx, tools, commands, sections, listeners, routes, projections };
}

/** 一个假会话。 */
function makeSession(dir, projected) {
	return { header: { cwd: dir }, projected };
}

/** 组件一次完整接线。 */
async function wire(dir, projected) {
	const made = makeContext();
	plugin.apply(made.ctx);
	const session = makeSession(dir, projected);
	const agent = { session, injected: [], steered: [], inject: (message) => agent.injected.push(message), steer: (message) => agent.steered.push(message) };
	return { ...made, session, agent };
}

/* ---------------- 命令 ---------------- */

await (async () => {
	const dir = makeProject('command');
	const wired = await wire(dir, { active: false, running: null });
	const command = wired.commands[0];
	check('命令注册成 /orchestrate', () => equal(command.name, 'orchestrate', '命令名'));
	const result = command.handler({ agent: wired.agent, rawInput: '' });
	check('开启命令回执可用', () => equal(result.kind, 'success', '回执种类'));
	check('开启后状态文件 enabled=true', () => {
		const { state } = store.readState(dir);
		equal(state.enabled, true, 'enabled');
	});
	check('开启时注入了一条提示', () => equal(wired.agent.injected.length, 1, '提示条数'));

	const wiredOff = await wire(dir, { active: true, running: null });
	const offResult = wiredOff.commands[0].handler({ agent: wiredOff.agent, rawInput: 'off' });
	check('关闭命令回执可用', () => equal(offResult.kind, 'success', '回执种类'));
	check('关闭后状态文件 enabled=false 且内容保留', () => {
		const { state } = store.readState(dir);
		equal(state.enabled, false, 'enabled');
	});
	rmSync(dir, { recursive: true, force: true });
})();

/* ---------------- 投影折叠 ---------------- */

check('投影只认 command/run 与 command/done', () => {
	const projection = plugin.internals.createModeProjection();
	let state = projection.init();
	equal(state.active, false, '初始未开启');
	state = projection.apply(state, { type: 'command/run', data: { name: 'orchestrate', commandId: 'c1', args: '' } });
	check('命令跑起来时按选择算生效', () => equal(projection.apply(state, { type: 'tool/call', data: {} }).running.wanted, true, 'wanted'));
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
	equal(state.active, true, '提交后生效');
	state = projection.apply(state, { type: 'command/run', data: { name: 'orchestrate', commandId: 'c2', args: 'off' } });
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c2', kind: 'success' } });
	equal(state.active, false, '关闭后不生效');
	equal(projection.apply(state, { type: 'noise', data: {} }), state, '无关事件返回同一引用');
});

/* ---------------- 提示词段 ---------------- */

await (async () => {
	const dir = makeProject('prompt');
	const active = await wire(dir, { active: true, running: null });
	const text = active.sections[0].text({ agent: active.agent });
	check('模式开着时提示词段有内容', () => {
		if (text.length === 0) throw new Error('提示词段是空的');
		if (!text.includes('调度者')) throw new Error('没写调度者角色');
		if (!text.includes('chart_submit')) throw new Error('没提 chart_submit');
	});
	const idle = await wire(dir, { active: false, running: null });
	check('模式关着时提示词段为空', () => equal(idle.sections[0].text({ agent: idle.agent }), '', '空串'));
	check('提示词段不抛异常', () => equal(idle.sections[0].text({}), '', '没有 agent 时也返回空串'));
	rmSync(dir, { recursive: true, force: true });
})();

/* ---------------- 两个工具 ---------------- */

await (async () => {
	const dir = makeProject('tools');
	const wired = await wire(dir, { active: true, running: null });

	const submit = wired.tools.get('chart_submit');
	const update = wired.tools.get('chart_update');
	check('两个工具都注册了', () => {
		if (submit === undefined) throw new Error('缺 chart_submit');
		if (update === undefined) throw new Error('缺 chart_update');
	});

	const submitted = await submit.execute({
		plan: { id: 'plan-a', name: '方案 A' },
		nodes: [{ id: 'n1', title: '查源码' }, { id: 'n2', title: '写模块' }],
		edges: [{ from: 'n1', to: 'n2' }],
	}, { agent: wired.agent });
	check('chart_submit 收下方案', () => {
		equal(submitted.accepted, true, 'accepted');
		equal(submitted.nodeCount, 2, '节点数');
	});
	check('方案存到 plans/ 下', () => {
		equal(store.listCharts(dir).includes('plan-a'), true, '存档里有 plan-a');
	});

	const updated = await update.execute({ selectedChart: 'plan-a' }, { agent: wired.agent });
	check('chart_update 选中方案', () => {
		equal(updated.selectedChart, 'plan-a', '选中图');
		equal(updated.revision >= 2, true, 'revision 递增');
	});
	await update.execute({ nodes: { n1: { status: '完成' } }, stage: '实现中', members: [{ name: 'coder', role: '写模块', status: '进行中' }] }, { agent: wired.agent });
	check('节点状态与成员写进状态文件', () => {
		const { state } = store.readState(dir);
		equal(state.nodes.n1.status, '完成', '节点状态');
		equal(state.members[0].name, 'coder', '成员');
		equal(state.stage, '实现中', '阶段');
	});

	// 换一个干净项目：它的状态文件里 enabled 还是 false。
	const idleDir = makeProject('tools-idle');
	const idle = await wire(idleDir, { active: false, running: null });
	await rejects('模式没开时 chart_submit 被拒', () => idle.tools.get('chart_submit').execute({
		plan: { id: 'plan-b', name: 'B' },
		nodes: [{ id: 'n1', title: '一' }],
		edges: [],
	}, { agent: idle.agent }), '编排模式');
	rmSync(idleDir, { recursive: true, force: true });

	// additionalProperties 要靠宿主自己的 JSON Schema 校验器；解析不到时会退化成「形状不强制」。
	const validator = await schema.loadSchemaValidator();
	if (validator === null) {
		console.log('跳过：解析不到宿主的 schema 校验器（节点外跑测试的正常情况）');
	} else {
		await rejects('工具参数多带字段被拒', () => submit.execute({
			plan: { id: 'plan-c', name: 'C' },
			nodes: [{ id: 'n1', title: '一' }],
			edges: [],
			typo: true,
		}, { agent: wired.agent }), 'schema');
	}
	rmSync(dir, { recursive: true, force: true });
})();

/* ---------------- 写文件警告 ---------------- */

await (async () => {
	const dir = makeProject('warn');
	const wired = await wire(dir, { active: true, running: null });
	const preExecute = (wired.listeners.get('tools/pre-execute') ?? [])[0];
	check('挂了 pre-execute 监听', () => {
		if (preExecute === undefined) throw new Error('没有 tools/pre-execute 监听');
	});
	const decision = await preExecute({ name: 'write', agent: wired.agent }, () => Promise.resolve({ kind: 'allow' }));
	check('写文件时警告并放行', () => {
		equal(decision.kind, 'allow', '决定是放行');
		equal(wired.agent.injected.length, 1, '警告条数');
		if (!wired.agent.injected[0].content[0].text.includes('派给成员')) throw new Error('警告文案不对');
	});
	await preExecute({ name: 'read', agent: wired.agent }, () => Promise.resolve({ kind: 'allow' }));
	check('读文件不警告', () => equal(wired.agent.injected.length, 1, '警告没增加'));
	rmSync(dir, { recursive: true, force: true });
})();

/* ---------------- 面板路由 ---------------- */

await (async () => {
	const dir = makeProject('route');
	store.writeState(dir, {
		...store.defaultState(),
		enabled: true,
		selectedChart: 'plan-a',
		stage: '实现中',
		nodes: { n1: { title: '查源码', status: '完成' } },
		charts: { 'plan-a': { id: 'plan-a', name: 'A', nodes: [{ id: 'n1', title: '查源码' }], edges: [] } },
	});
	const wired = await wire(dir, { active: true, running: null });
	const route = wired.routes.find((item) => item.path === '/api/orchestrate.state');
	check('注册了读状态的路由', () => {
		if (route === undefined) throw new Error('没有 /api/orchestrate.state');
	});
	const response = await route.fetch(new Request('http://localhost/api/orchestrate.state?cwd=' + encodeURIComponent(dir)));
	const body = await response.json();
	check('路由返回面板要的字段', () => {
		equal(body.enabled, true, 'enabled');
		equal(body.selectedChart, 'plan-a', 'selectedChart');
		equal(body.nodes[0].status, '完成', '节点状态');
		equal(body.stage, '实现中', 'stage');
	});
	rmSync(dir, { recursive: true, force: true });
})();



check('团队工具缺席与在场给不同回执', () => {
	const dir = makeProject('team');
	const idle = makeContext();
	plugin.apply(idle.ctx);
	const session = makeSession(dir, { active: false, running: null });
	const agent = { session, injected: [], inject: (message) => agent.injected.push(message), steer: () => {} };
	const offText = idle.commands[0].handler({ agent, rawInput: '' }).text;
	if (!offText.includes('回退')) throw new Error('缺席时回执没说回退：' + offText);

	const team = makeContext();
	team.ctx.tools.register({ name: 'spawn_teammate', description: 'stub', parameters: { type: 'object' }, execute: async () => ({}) });
	plugin.apply(team.ctx);
	const teamAgent = { session, injected: [], inject: (message) => teamAgent.injected.push(message), steer: () => {} };
	const onText = team.commands[0].handler({ agent: teamAgent, rawInput: '' }).text;
	if (onText.includes('回退')) throw new Error('团队在场时不该说回退：' + onText);
	if (!onText.includes('成员之间可以直接对话')) throw new Error('团队在场时没说明成员能直接对话：' + onText);
	rmSync(dir, { recursive: true, force: true });
});

check('同一项目的两个会话共用一份状态', () => {
	const dir = makeProject('shared');
	const nested = join(dir, 'sub');
	mkdirSync(nested, { recursive: true });
	const { state } = store.writeState(nested, { ...store.defaultState(), enabled: true, stage: '共享' });
	equal(store.resolveStatePath(dir), store.resolveStatePath(nested), '两个目录解析到同一份状态文件');
	equal(store.readState(dir).state.stage, '共享', '另一个会话读到同一份');
	equal(state.stage, '共享', '写进去的值');
	rmSync(dir, { recursive: true, force: true });
});


/* ---------------- 成员与主对话的分界 ---------------- */

await (async () => {
	const dir = makeProject('member');
	// 项目状态里 enabled=true 就是「模式开着」在盘上的镜像；命令处理里是它写的。
	store.writeState(dir, { ...store.defaultState(), enabled: true });
	const wired = await wire(dir, { active: false, running: null });
	const memberSession = { header: { cwd: dir, origin: 'subagent' }, projected: undefined };
	const memberAgent = { session: memberSession, injected: [], inject: () => {}, steer: () => {} };

	const submitted = await wired.tools.get('chart_submit').execute({
		plan: { id: 'plan-m', name: '成员方案' },
		nodes: [{ id: 'n1', title: '查资料' }, { id: 'n2', title: '写结论' }],
		edges: [{ from: 'n1', to: 'n2' }],
	}, { agent: memberAgent });
	check('成员没有模式投影也能交图', () => {
		equal(submitted.accepted, true, 'accepted');
		equal(store.listCharts(dir).includes('plan-m'), true, '存档里有 plan-m');
	});

	await rejects('成员不能改进度', () => wired.tools.get('chart_update').execute({ stage: '抢进度' }, { agent: memberAgent }), '主对话的工具');

	// enabled=false 时成员也交不了：模式关掉就不该再有成员进来交图。
	const off = makeProject('member-off');
	store.writeState(off, { ...store.defaultState(), enabled: false });
	const offWired = await wire(off, { active: false, running: null });
	await rejects('模式关着时成员交图被拒', () => offWired.tools.get('chart_submit').execute({
		plan: { id: 'plan-x', name: 'X' },
		nodes: [{ id: 'n1', title: '一' }],
		edges: [],
	}, { agent: { session: { header: { cwd: off, origin: 'subagent' } }, inject: () => {} } }), '编排模式');

	rmSync(dir, { recursive: true, force: true });
	rmSync(off, { recursive: true, force: true });
});

/* ---------------- 网页面板（假 DOM / 假 react） ---------------- */

/**
 * 造一个能跑 client.js 的浏览器环境。
 * @param {object} payloads 项目目录到路由返回数据的映射；键 '' 是不带目录的那次。
 * @returns {object} 环境句柄。
 */
function makeBrowser(payloads) {
	const registrations = [];
	const disposers = [];
	const tabTypes = [];
	const calls = [];
	const fetches = [];
	const elements = [];
	let openTabs = [];
	let expanded = false;
	let activeKind = null;
	/** 右侧栏当前对着哪个会话。 */
	let mountedSession = 's1';
	/** 会话到项目目录：假会话清单；s3 故意不给，用来测「问不到目录」。 */
	const sessionDirs = { s1: '/tmp/p1', s2: '/tmp/p2', s4: '/tmp/p1' };
	/** 假定时器：只记账，不真的跑。 */
	const timers = new Set();
	globalThis.setInterval = (fn, ms) => {
		const handle = { fn, ms };
		timers.add(handle);
		return handle;
	};
	globalThis.clearInterval = (handle) => { timers.delete(handle); };
	globalThis.window = {
		__ModuleLoader__: { load: (registration) => { globalThis.__clientModule = registration; } },
		matchMedia: () => ({ matches: false }),
	};
	globalThis.document = {
		getElementById: () => null,
		createElement: () => {
			const element = { style: {}, textContent: '', id: '' };
			elements.push(element);
			return element;
		},
		head: { appendChild: () => {} },
	};
	globalThis.fetch = async (url) => {
		fetches.push(String(url));
		const cwd = new URL(String(url), 'http://localhost').searchParams.get('cwd') ?? '';
		const payload = payloads[cwd] ?? payloads[''];
		if (payload === undefined) throw new Error('自测没给这个项目准备数据：' + cwd);
		return { ok: true, json: async () => payload };
	};
	const unsubscribes = [];
	/** 已经挂过的订阅，避免重复挂。 */
	const subscribed = new Set();
	const reactFake = {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined) };
		},
		useRef: (value) => ({ current: value }),
		useEffect: () => {},
		// 订阅一次就够：真 react 在这里挂订阅、收到通知重渲染，假货只负责挂上。
		useSyncExternalStore: (subscribe, getSnapshot) => {
			if (!subscribed.has(subscribe)) {
				subscribed.add(subscribe);
				unsubscribes.push(subscribe(() => {}));
			}
			return getSnapshot();
		},
	};
	const ctx = {
		slots: {
			inject: (name, callback) => callback(),
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {
					const index = registrations.findIndex((item) => item.options === options);
					if (index !== -1) registrations.splice(index, 1);
				};
			},
		},
		sidebarRightTabs: {
			register: (definition) => {
				tabTypes.push(definition);
				return () => {
					const index = tabTypes.indexOf(definition);
					if (index !== -1) tabTypes.splice(index, 1);
				};
			},
		},
		sidebarRight: {
			openTab: (kind) => { calls.push(['openTab', kind]); },
			hide: (tabId) => { calls.push(['hide', tabId]); },
			tabsIn: (sessionId) => { calls.push(['tabsIn', sessionId]); return openTabs; },
			active: () => (activeKind === null ? undefined : { kind: activeKind }),
			isExpanded: () => expanded,
			mounted: { getSnapshot: () => mountedSession },
		},
		sessions: {
			list: { getSnapshot: () => ({ byId: Object.fromEntries(Object.entries(sessionDirs).map(([id, cwd]) => [id, { cwd }])) }) },
			binding: (sessionId) => (sessionDirs[sessionId] === undefined ? undefined : {
				session: { projections: { faceOf: () => ({ getSnapshot: () => sessionDirs[sessionId] }) } },
			}),
		},
		effect: (fn) => {
			const dispose = fn();
			disposers.push(dispose);
			return dispose;
		},
	};
	/** 摆好右侧栏当时的模样：开了哪些页、栏有没有展开、当前页是哪个。 */
	const setRight = (state) => {
		openTabs = state.tabs ?? [];
		expanded = state.expanded ?? false;
		activeKind = state.active ?? null;
		mountedSession = state.mounted ?? 's1';
	};
	return { registrations, disposers, tabTypes, calls, fetches, elements, timers, reactFake, ctx, setRight, unsubscribes };
}

/** 把 client.js 当浏览器模块加载一遍（每次加 query 拿新实例）。 */
async function loadClient(payloads) {
	const browser = makeBrowser(payloads);
	await import('./client.js?case=' + encodeURIComponent(String(Date.now()) + Math.random()));
	const factory = globalThis.__clientModule.factory;
	const moduleExports = factory((name) => {
		if (name === 'react') return browser.reactFake;
		if (name === 'react/jsx-runtime') return browser.reactFake;
		throw new Error('未预期的 require：' + name);
	});
	return { ...browser, moduleExports };
}

/** 等一小会儿，让轮询落地。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 摊平一棵假元素树，收出所有文本。
 * @param {object} page 组件树根。
 * @returns {string[]} 文本片段。
 */
function collectTexts(page) {
	const texts = [];
	const walk = (node) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		// 假 createElement 不会自己渲染函数组件，这里手动展开一层。
		if (typeof node.type === 'function') {
			walk(node.type(node.props));
			return;
		}
		for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
		walk(node.children ?? []);
	};
	walk(page);
	return texts;
}

await (async () => {
	/** 开了编排的项目。 */
	const on = {
		cwd: '/tmp/p1',
		enabled: true,
		selectedChart: 'plan-a',
		stage: '实现中',
		next: '等 n2',
		members: [{ name: 'coder', role: '写模块', status: '进行中' }],
		charts: [{ id: 'plan-a', name: '方案 A' }],
		nodes: [{ id: 'n1', title: '查资料', status: '完成' }, { id: 'n2', title: '写结论', status: '进行中' }],
		edges: [{ from: 'n1', to: 'n2' }],
	};
	/** 没开编排的另一个项目。 */
	const off = { cwd: '/tmp/p2', enabled: false, selectedChart: null, stage: '', next: '', members: [], charts: [], nodes: [], edges: [] };
	const loaded = await loadClient({ '/tmp/p1': on, '/tmp/p2': off, '': off });
	loaded.moduleExports.apply(loaded.ctx);
	await sleep(50);

	check('挂头部按钮与右侧栏标签页', () => {
		const names = loaded.registrations.map((item) => item.options.name).sort();
		equal(names, ['conversation.session.header.utilities', 'sidebar.right.pane.tab'], '注册的槽位');
		equal(loaded.tabTypes.length, 1, '标签页类型数');
		equal(loaded.tabTypes[0].id, 'dsh-method', '标签页注册 id');
		equal(loaded.tabTypes[0].kind, 'orchestrate', '标签页类型');
		equal(loaded.tabTypes[0].title(), '编排', '标签页标题');
		const header = loaded.registrations.find((item) => item.options.name === 'conversation.session.header.utilities');
		equal(header.options.id, 'orchestrate', '头部按钮 id');
		equal(header.options.order, -6, '头部按钮顺序');
		const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab');
		equal(body.options.key, 'dsh-method', '标签体的 key');
	});

	check('按会话所在项目问状态', () => {
		const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab').component;
		body({ sessionId: 's1' });
		body({ sessionId: 's2' });
		if (!loaded.fetches.some((url) => url.includes('cwd=%2Ftmp%2Fp1'))) throw new Error('没按 s1 的项目问：' + loaded.fetches.join(' | '));
		if (!loaded.fetches.some((url) => url.includes('cwd=%2Ftmp%2Fp2'))) throw new Error('没按 s2 的项目问：' + loaded.fetches.join(' | '));
	});

	check('问不到项目目录的会话不订阅、不轮询', () => {
		const header = loaded.registrations.find((item) => item.options.name === 'conversation.session.header.utilities').component;
		const before = loaded.timers.size;
		equal(header({ sessionId: 's3', toggle: () => {} }), null, 's3 的按钮');
		equal(loaded.timers.size, before, '没起轮询');
		if (loaded.fetches.some((url) => !url.includes('cwd=') || url.endsWith('cwd='))) throw new Error('发了不带目录的请求：' + loaded.fetches.join(' | '));
	});

	await sleep(40);

	check('项目没开编排时头部不画图标', () => {
		const header = loaded.registrations.find((item) => item.options.name === 'conversation.session.header.utilities');
		const quiet = header.options.inject('s2');
		equal(header.component({ ...quiet, sessionId: 's2' }), null, 's2 的按钮');
	});

	check('点头部图标打开标签页，开着时再点收起', () => {
		const header = loaded.registrations.find((item) => item.options.name === 'conversation.session.header.utilities');
		const face = header.options.inject('s1');
		const button = header.component({ ...face, sessionId: 's1' });
		equal(button.props['aria-label'], '编排', '按钮名称');

		loaded.setRight({ tabs: [], expanded: false });
		button.props.onClick();
		equal(loaded.calls.at(-1), ['openTab', 'orchestrate'], '没开时点一下：打开标签页');

		loaded.setRight({ tabs: [{ id: 'tab-1', kind: 'orchestrate' }], expanded: true, active: 'other' });
		button.props.onClick();
		equal(loaded.calls.at(-1), ['openTab', 'orchestrate'], '被别的页盖住时点一下：聚焦回编排');

		loaded.setRight({ tabs: [{ id: 'tab-1', kind: 'orchestrate' }], expanded: true, active: 'orchestrate' });
		button.props.onClick();
		equal(loaded.calls.at(-1), ['hide', 'tab-1'], '正开着时点一下：收起');

		loaded.setRight({ tabs: [{ id: 'tab-1', kind: 'orchestrate' }], expanded: true, active: 'orchestrate' });
		loaded.ctx.sidebarRight.isExpanded = () => false;
		button.props.onClick();
		equal(loaded.calls.at(-1), ['openTab', 'orchestrate'], '栏收起了但页还在：再展开');
	});

	check('同一项目的两个会话共用一条轮询', () => {
		const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab').component;
		const timersBefore = loaded.timers.size;
		const requestsBefore = loaded.fetches.filter((url) => url.includes('%2Ftmp%2Fp1')).length;
		body({ sessionId: 's4' });
		equal(loaded.timers.size, timersBefore, '没起第二条轮询');
		equal(loaded.fetches.filter((url) => url.includes('%2Ftmp%2Fp1')).length, requestsBefore, '复用了已有那份');
	});

	check('标签页画出节点与连线', () => {
		const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab').component;
		const page = body({ sessionId: 's1' });
		const stack = [];
		const walk = (node) => {
			if (node === null || typeof node !== 'object') return;
			if (Array.isArray(node)) {
				for (const child of node) walk(child);
				return;
			}
			// 假 createElement 不会自己渲染函数组件，这里手动展开一层。
			if (typeof node.type === 'function') {
				walk(node.type(node.props));
				return;
			}
			stack.push(node);
			walk(node.children ?? []);
		};
		walk(page);
		const svg = stack.find((node) => node.type === 'svg');
		if (svg === undefined) throw new Error('没有画出 svg');
		const groups = stack.filter((node) => node.type === 'g' && node.props['data-status'] !== undefined);
		equal(groups.length, 2, '节点数');
		equal(groups.map((node) => node.props['data-status']).sort(), ['完成', '进行中'], '节点状态');
		const stage = stack.find((node) => node.children.includes('实现中'));
		if (stage === undefined) throw new Error('没画阶段一句话');
	});

	check('样式只插一次', () => equal(loaded.elements.filter((element) => element.id === 'dsh-orchestrate-style').length, 1, '样式标签数'));

	check('没人看就停轮询', () => {
		for (const off of loaded.unsubscribes) if (typeof off === 'function') off();
		equal(loaded.timers.size, 0, '还活着的轮询数');
	});
	for (const off of loaded.unsubscribes) if (typeof off === 'function') off();
	for (const dispose of loaded.disposers) if (typeof dispose === 'function') dispose();
})();

await (async () => {
	const loaded = await loadClient({ '/tmp/p2': { cwd: '/tmp/p2', enabled: false, selectedChart: null, stage: '', next: '', members: [], charts: [], nodes: [], edges: [] }, '': { enabled: false } });
	loaded.moduleExports.apply(loaded.ctx);
	await sleep(50);
	const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab').component;
	body({ sessionId: 's2' });
	await sleep(30);

	check('没开的项目标签页讲清怎么开', () => {
		const texts = collectTexts(body({ sessionId: 's2' }));
		if (!texts.some((text) => text.includes('还没开启编排'))) throw new Error('没讲「还没开启编排」：' + texts.join(' | '));
		if (!texts.some((text) => text.includes('/orchestrate'))) throw new Error('没给开启方式：' + texts.join(' | '));
	});
	for (const off of loaded.unsubscribes) if (typeof off === 'function') off();
	for (const dispose of loaded.disposers) if (typeof dispose === 'function') dispose();
})();

await (async () => {
	const loaded = await loadClient({
		'/tmp/p1': {
			cwd: '/tmp/p1',
			enabled: true,
			selectedChart: null,
			stage: '',
			next: '',
			members: [],
			charts: [{ id: 'plan-a', name: '方案 A' }],
			nodes: [],
			edges: [],
		},
		'': { enabled: false },
	});
	loaded.moduleExports.apply(loaded.ctx);
	await sleep(50);
	const body = loaded.registrations.find((item) => item.options.name === 'sidebar.right.pane.tab').component;
	body({ sessionId: 's1' });
	await sleep(30);
	check('有方案没选中时给一句说明', () => {
		const texts = collectTexts(body({ sessionId: 's1' }));
		if (!texts.some((text) => text.includes('还没选中'))) throw new Error('没提示「还没选中」：' + texts.join(' | '));
	});
	for (const off of loaded.unsubscribes) if (typeof off === 'function') off();
	for (const dispose of loaded.disposers) if (typeof dispose === 'function') dispose();
})();

/* ---------------- 结果 ---------------- */

if (failures.length > 0) {
	console.error(`失败 ${failures.length} 项，通过 ${passed} 项，共跑了 ${attempted} 项：`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`全部通过：${passed} 项（共跑了 ${attempted} 项，跳过 ${attempted - passed} 项）`);
}