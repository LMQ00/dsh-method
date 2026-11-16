/**
 * 编排状态落盘：项目根 .orchestrate/state.json、方案存档 plans/、以及给手机面板看的镜像文件。
 *
 * 写盘一律「临时文件 + rename」，面板侧永远读到完整 JSON。读盘遇到损坏文件先备份成
 * state.json.bad 再当空状态处理，避免一次手改让插件永久读不出。
 *
 * @module dsh-method/store
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 项目根下的状态目录。 */
export const STATE_DIR = '.orchestrate';

/** 节点与成员共用的状态闭集。 */
export const STATUSES = ['待办', '进行中', '完成', '失败'];

/** 新建节点、成员的初始状态。 */
export const DEFAULT_STATUS = '待办';

/** 状态文件格式版本。 */
export const STATE_VERSION = 1;

/** DSH 自己的项目根标记；沙箱里没有 .git 时退回会话目录。 */
const PROJECT_ROOT_MARKERS = ['.git'];

/**
 * 最近的、带项目根标记的上级目录，找不到就用 cwd 自己。
 * @param {string} cwd 会话工作目录。
 * @returns {string} 绝对路径。
 */
export function findProjectAnchor(cwd) {
	const start = resolve(cwd);
	const home = (() => {
		try {
			return resolve(homedir());
		} catch {
			return '';
		}
	})();
	let current = start;
	for (;;) {
		if (home !== '' && current === home) return start;
		for (const marker of PROJECT_ROOT_MARKERS) {
			if (existsSync(join(current, marker))) return current;
		}
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/** 状态文件路径。 */
export function resolveStatePath(cwd) {
	return join(findProjectAnchor(cwd), STATE_DIR, 'state.json');
}

/** 方案存档目录。 */
export function resolvePlansDir(cwd) {
	return join(findProjectAnchor(cwd), STATE_DIR, 'plans');
}

/** 空状态。 */
export function defaultState() {
	return {
		version: STATE_VERSION,
		enabled: false,
		selectedChart: null,
		stage: '',
		next: '',
		members: [],
		nodes: {},
		charts: {},
		revision: 0,
		updatedAt: '',
	};
}

/** 是否普通对象。 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 取字符串，非字符串给兜底值。 */
function text(value, fallback = '') {
	return typeof value === 'string' ? value : fallback;
}

/** 合法的状态值，否则回到默认值。 */
export function normalizeStatus(value) {
	return STATUSES.includes(value) ? value : DEFAULT_STATUS;
}

/** 把写坏的成员数组修回可读结构。 */
function normalizeMembers(value) {
	if (!Array.isArray(value)) return [];
	const members = [];
	for (const item of value) {
		if (!isPlainObject(item)) continue;
		const name = text(item.name).trim();
		if (name === '') continue;
		members.push({ name, role: text(item.role), status: normalizeStatus(item.status) });
	}
	return members;
}

/** 把写坏的节点记录修回可读结构。 */
function normalizeNodes(value) {
	const nodes = {};
	if (!isPlainObject(value)) return nodes;
	for (const [id, node] of Object.entries(value)) {
		if (!isPlainObject(node)) continue;
		nodes[id] = { title: text(node.title, id), status: normalizeStatus(node.status) };
	}
	return nodes;
}

/** 把写坏的方案记录修回可读结构。 */
function normalizeChart(id, value) {
	if (!isPlainObject(value)) return null;
	const nodes = [];
	if (Array.isArray(value.nodes)) {
		for (const node of value.nodes) {
			if (!isPlainObject(node)) continue;
			const nodeId = text(node.id).trim();
			if (nodeId === '') continue;
			nodes.push({ id: nodeId, title: text(node.title, nodeId) });
		}
	}
	const known = new Set(nodes.map((node) => node.id));
	const edges = [];
	if (Array.isArray(value.edges)) {
		for (const edge of value.edges) {
			if (!isPlainObject(edge)) continue;
			const from = text(edge.from).trim();
			const to = text(edge.to).trim();
			if (!known.has(from) || !known.has(to)) continue;
			edges.push({ from, to });
		}
	}
	return { id, name: text(value.name, id), nodes, edges, submittedAt: text(value.submittedAt) };
}

/** 把整份状态修回可读结构。 */
export function normalizeState(value) {
	const base = defaultState();
	if (!isPlainObject(value)) return base;
	const state = {
		version: STATE_VERSION,
		enabled: value.enabled === true,
		selectedChart: typeof value.selectedChart === 'string' && value.selectedChart !== '' ? value.selectedChart : null,
		stage: text(value.stage),
		next: text(value.next),
		members: normalizeMembers(value.members),
		nodes: normalizeNodes(value.nodes),
		charts: {},
		revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
		updatedAt: text(value.updatedAt),
	};
	if (isPlainObject(value.charts)) {
		for (const [id, chart] of Object.entries(value.charts)) {
			const normalized = normalizeChart(id, chart);
			if (normalized !== null) state.charts[id] = normalized;
		}
	}
	return state;
}

/**
 * 读项目状态。文件不存在给空状态；坏了先备份再给空状态。
 * @param {string} cwd 会话工作目录。
 * @returns {{state: object, broken: boolean, path: string}} 读到的状态。
 */
export function readState(cwd) {
	const path = resolveStatePath(cwd);
	if (!existsSync(path)) return { state: defaultState(), broken: false, path };
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return { state: defaultState(), broken: true, path };
	}
	try {
		return { state: normalizeState(JSON.parse(raw)), broken: false, path };
	} catch {
		try {
			renameSync(path, `${path}.bad`);
		} catch {
			// 备份失败不影响重新建一份状态。
		}
		return { state: defaultState(), broken: true, path };
	}
}

/** 写临时文件再 rename，面板侧只会看到完整文件。 */
function writeAtomic(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, contents, 'utf8');
	renameSync(temp, path);
}

/** 首次建目录时放一个自忽略的 .gitignore，不碰项目自己的 .gitignore。 */
function ensureIgnore(statePath) {
	const ignorePath = join(dirname(statePath), '.gitignore');
	if (existsSync(ignorePath)) return;
	try {
		writeFileSync(ignorePath, '*\n', 'utf8');
	} catch {
		// 写不了就算了，状态文件本身照写。
	}
}

/**
 * 手机面板读的镜像文件路径。
 * @returns {string} 绝对路径。
 */
export function resolveMirrorPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'dsh-go', 'orchestrate', 'mirror.json');
}

/** 选中图的节点与连线，按提交顺序输出成数组，方便面板直接画。 */
export function flattenChart(state) {
	const chartId = state.selectedChart;
	const chart = chartId === null ? undefined : state.charts[chartId];
	if (chart === undefined) return { nodes: [], edges: [] };
	const nodes = chart.nodes.map((node) => ({
		id: node.id,
		title: state.nodes[node.id]?.title ?? node.title,
		status: normalizeStatus(state.nodes[node.id]?.status),
	}));
	return { nodes, edges: chart.edges.map((edge) => ({ from: edge.from, to: edge.to })) };
}

/**
 * 写项目状态，并把同一份内容镜像给手机面板。
 * @param {string} cwd 会话工作目录。
 * @param {object} state 已经改好的状态。
 * @returns {{state: object, path: string, mirrorPath: string}} 落盘结果。
 */
export function writeState(cwd, state) {
	const path = resolveStatePath(cwd);
	const normalized = normalizeState(state);
	normalized.revision = normalized.revision + 1;
	normalized.updatedAt = new Date().toISOString();
	mkdirSync(dirname(path), { recursive: true });
	ensureIgnore(path);
	writeAtomic(path, `${JSON.stringify(normalized, null, 2)}\n`);
	const mirrorPath = resolveMirrorPath();
	const flat = flattenChart(normalized);
	const mirror = {
		cwd: findProjectAnchor(cwd),
		enabled: normalized.enabled,
		selectedChart: normalized.selectedChart,
		stage: normalized.stage,
		next: normalized.next,
		updatedAt: normalized.updatedAt,
		members: normalized.members,
		nodes: flat.nodes,
		edges: flat.edges,
	};
	try {
		writeAtomic(mirrorPath, `${JSON.stringify(mirror, null, 2)}\n`);
	} catch {
		// 手机面板是附加能力，写不了不影响仓库里的状态文件。
	}
	return { state: normalized, path, mirrorPath };
}

/**
 * 把一份方案存档到 plans/<id>.json。
 * @param {string} cwd 会话工作目录。
 * @param {object} chart 方案（含 id、name、nodes、edges）。
 * @returns {string} 存档路径。
 */
export function archiveChart(cwd, chart) {
	const path = join(resolvePlansDir(cwd), `${chart.id}.json`);
	writeAtomic(path, `${JSON.stringify(chart, null, 2)}\n`);
	return path;
}

/**
 * 列出已存档的方案 id。
 * @param {string} cwd 会话工作目录。
 * @returns {string[]} 方案 id 列表。
 */
export function listCharts(cwd) {
	const dir = resolvePlansDir(cwd);
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith('.json'))
			.map((name) => name.slice(0, -'.json'.length))
			.sort();
	} catch {
		return [];
	}
}
