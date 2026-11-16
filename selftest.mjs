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
const failures = [];

/** 一个断言。 */
function check(name, fn) {
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

/* ---------------- 结果 ---------------- */

if (failures.length > 0) {
	console.error(`失败 ${failures.length} 项，通过 ${passed} 项：`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`全部通过：${passed} 项`);
}
