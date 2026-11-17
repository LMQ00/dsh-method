#!/usr/bin/env node
/**
 * 纯逻辑自测：状态落盘、字段完整性校验、进度更新。跑法：node selftest.mjs
 *
 * 只测不依赖宿主的模块（store.js / schema.js / prompt.js）。工具、命令、提示词段要在真实 dsh 里验。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, 'tmp');
mkdirSync(tempRoot, { recursive: true });
const store = await import('./store.js');
const schema = await import('./schema.js');
const prompt = await import('./prompt.js');

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

check('节点按连线顺序排，自环不算入边', () => {
	const flat = {
		nodes: [{ id: 'n3' }, { id: 'n1' }, { id: 'n2' }, { id: 'loop' }],
		edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'loop', to: 'loop' }],
	};
	// loop 只指向自己，等于没有入边，跟 n1 一起当起点，不会被挤到最后。
	equal(store.orderChartNodes(flat).map((node) => node.id), ['n1', 'loop', 'n2', 'n3'], '排序');
});

check('成环的节点一个不丢', () => {
	const flat = {
		nodes: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
		edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }, { from: 'y', to: 'z' }],
	};
	const order = store.orderChartNodes(flat).map((node) => node.id);
	equal(order.length, 3, '节点数');
	equal(order.slice().sort(), ['x', 'y', 'z'], '节点集合');
});

check('提示词带上当前方案与节点状态', () => {
	const text = prompt.dispatchPolicy({
		hasTeam: true,
		hasTodo: true,
		plansDir: '/p/.orchestrate/plans',
		statePath: '/p/.orchestrate/state.json',
		stage: '实现中',
		next: '等 n2',
		members: [{ name: 'coder', role: '写模块', status: '进行中' }],
		chart: {
			id: 'plan-a',
			name: '方案 A',
			nodes: [{ id: 'n1', title: '查资料', status: '完成' }, { id: 'n2', title: '写结论', status: '进行中' }],
			edges: [{ from: 'n1', to: 'n2' }],
			done: 1,
			total: 2,
		},
	});
	if (!text.includes('## 当前方案：方案 A（1/2 完成）')) throw new Error('没写图名与进度：' + text.slice(0, 400));
	if (!text.includes('[完成] n1 查资料')) throw new Error('没写节点状态');
	if (!text.includes('下一步：等 n2')) throw new Error('没写下一步');
	if (!text.includes('coder（写模块）进行中')) throw new Error('没写成员');
	if (!text.includes('## 待办')) throw new Error('没写待办那一段');
	if (!text.includes('pending / in_progress / completed')) throw new Error('没给待办状态名');
	if (!text.includes('节点 id + 空格 + 节点标题')) throw new Error('没说 content 怎么写');
	if (!text.includes('完成 → completed')) throw new Error('没给状态映射');
	if (!text.includes('整份替换')) throw new Error('没说 todo_write 是整份替换');
});

check('没有待办工具时不写待办那一段', () => {
	const text = prompt.dispatchPolicy({
		hasTeam: true,
		hasTodo: false,
		plansDir: '/p/.orchestrate/plans',
		statePath: '/p/.orchestrate/state.json',
		chart: null,
		stage: '',
		next: '',
		members: [],
	});
	if (text.includes('## 待办')) throw new Error('没有 todo_write 却写了待办段');
	if (!text.includes('## 进度')) throw new Error('进度段没了');
});

check('没有图时提示词不带图那一段', () => {
	const text = prompt.dispatchPolicy({
		hasTeam: false,
		plansDir: '/p/.orchestrate/plans',
		statePath: '/p/.orchestrate/state.json',
		chart: null,
		stage: '',
		next: '',
		members: [],
	});
	if (text.includes('## 当前方案')) throw new Error('没有方案却写了方案那段');
	if (!text.includes('# 编排模式：你是调度者')) throw new Error('主体没了');
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

check('选中方案 + 点亮节点', () => {
	const first = schema.applyUpdate({ selectedChart: 'plan-a' }, stateWithChart());
	equal(first.state.selectedChart, 'plan-a', '选中方案');
	const second = schema.applyUpdate({ nodes: { n1: { status: '完成' } }, stage: '实现中', next: '等 n2', members: [{ name: 'coder' }] }, first.state);
	equal(second.state.nodes.n1.status, '完成', '节点状态');
	equal(second.state.members[0].status, '待办', '成员默认状态');
	equal(second.state.stage, '实现中', 'stage');
});

await rejects('非法节点状态', () => schema.applyUpdate({ nodes: { n1: { status: '跑了' } } }, { ...stateWithChart(), selectedChart: 'plan-a' }), 'nodes.n1.status');
await rejects('节点 id 不在选中方案里', () => schema.applyUpdate({ nodes: { n9: { status: '完成' } } }, { ...stateWithChart(), selectedChart: 'plan-a' }), 'nodes.n9');
await rejects('没选图就改节点', () => schema.applyUpdate({ nodes: { n1: { status: '完成' } } }, stateWithChart()), '还没选中方案');
await rejects('选不存在的方案', () => schema.applyUpdate({ selectedChart: 'plan-z' }, stateWithChart()), 'selectedChart');
await rejects('一个字段都没给', () => schema.applyUpdate({}, stateWithChart()), '至少给一个');


/* ---------------- 宿主接线（假 ctx） ---------------- */

const plugin = await import('./index.js');

/**
 * 造一个能装下插件注册物的假 ctx。
 * @returns {object} { ctx, tools, commands, sections, listeners, projections }
 */
function makeContext() {
	const tools = new Map();
	const commands = [];
	const sections = [];
	const listeners = new Map();
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
						}
		},
	};
	return { ctx, tools, commands, sections, listeners, projections };
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
		equal(updated.selectedChart, 'plan-a', '选中方案');
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

/* ---------------- 结果 ---------------- */

if (failures.length > 0) {
	console.error(`失败 ${failures.length} 项，通过 ${passed} 项，共跑了 ${attempted} 项：`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`全部通过：${passed} 项（共跑了 ${attempted} 项，跳过 ${attempted - passed} 项）`);
}