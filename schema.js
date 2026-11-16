/**
 * 两个工具的入参契约：JSON Schema 给模型看，字段完整性校验给插件自己用。
 *
 * DSH 的 tools.register 只校验 output schema，parameters 原样交给 provider，execute 拿到裸入参；
 * 所以 additionalProperties: false 要靠 validateJsonSchemaValue 自己调一次才生效。
 *
 * @module dsh-method/schema
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { STATUSES } from './store.js';

/** 一个字段级错误，message 直接点名哪个字段哪个取值。 */
export class ChartError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ChartError';
	}
}

/** 方案 id 同时是文件名，限制成安全字符。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 方案 id 的最长长度。 */
const ID_MAX = 40;

/** chart_submit 的入参 schema。 */
export const CHART_SUBMIT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['plan', 'nodes', 'edges'],
	properties: {
		plan: {
			type: 'object',
			additionalProperties: false,
			required: ['id', 'name'],
			description: '这条方案的名字。id 会是存档文件名，用 [a-z0-9-] 写。',
			properties: {
				id: { type: 'string', description: '方案 id：小写字母、数字与短横，例如 plan-a。' },
				name: { type: 'string', description: '方案显示名，一句短话。' },
			},
		},
		nodes: {
			type: 'array',
			description: '节点：这一步做什么。id 只在这张图内唯一，后续 chart_update 用它点亮。',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'title'],
				properties: {
					id: { type: 'string', description: '节点 id，例如 n1。' },
					title: { type: 'string', description: '节点标题：这一步要做什么。' },
				},
			},
		},
		edges: {
			type: 'array',
			description: '连线：from 到 to，两端都必须是上面出现过的节点 id。没有先后关系的单步方案给空数组。',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['from', 'to'],
				properties: {
					from: { type: 'string', description: '起点节点 id。' },
					to: { type: 'string', description: '终点节点 id。' },
				},
			},
		},
	},
};

/** chart_update 的入参 schema。 */
export const CHART_UPDATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		selectedChart: { type: 'string', description: '选中哪张方案图；必须是成员交上来的方案 id。' },
		stage: { type: 'string', description: '当前阶段，一句话，例如「实现中」。' },
		next: { type: 'string', description: '下一步等什么，一句话。' },
		members: {
			type: 'array',
			description: '成员清单，整份替换。status 只能是 待办 / 进行中 / 完成 / 失败，省略当待办。',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name'],
				properties: {
					name: { type: 'string', description: '成员名字。' },
					role: { type: 'string', description: '这名成员负责什么。' },
					status: { type: 'string', enum: STATUSES, description: '这名成员当前的进展。' },
				},
			},
		},
		nodes: {
			type: 'object',
			description: '按节点 id 改标题或状态。只写要改的节点，没写的保持原样。',
			additionalProperties: {
				type: 'object',
				additionalProperties: false,
				properties: {
					title: { type: 'string', description: '新标题，一般不用改。' },
					status: { type: 'string', enum: STATUSES, description: '这个节点现在的状态。' },
				},
			},
		},
	},
};

/** schema 校验器，懒解析一次。 */
let validatorPromise;

/**
 * 解析宿主自己的 JSON Schema 校验器。
 * 插件的 profile 里没有 link @deepseek-ai/dsh-tools，所以从 dsh 入口往上找它的安装位置；
 * 找不到就退化成「形状不强制」，字段完整性校验照样跑。
 * @returns {Promise<((schema: object, value: unknown, path: string) => string[]) | null>} 校验器或 null。
 */
export function loadSchemaValidator() {
	if (validatorPromise !== undefined) return validatorPromise;
	validatorPromise = (async () => {
		const candidates = ['@deepseek-ai/dsh-tools'];
		const entry = typeof process.argv[1] === 'string' ? process.argv[1] : '';
		if (entry !== '') {
			let current = dirname(entry);
			for (;;) {
				for (const candidate of [
					join(current, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
					join(current, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
				]) {
					if (existsSync(candidate)) candidates.push(pathToFileURL(candidate).href);
				}
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
		}
		for (const candidate of candidates) {
			try {
				const module = await import(candidate);
				if (typeof module.validateJsonSchemaValue === 'function') return module.validateJsonSchemaValue;
			} catch {
				// 换下一个位置。
			}
		}
		return null;
	})();
	return validatorPromise;
}

/**
 * 入参不符合声明的 schema 就抛错。
 * @param {object} schema 工具 schema。
 * @param {unknown} args 模型给的裸入参。
 */
export async function assertArgsMatchSchema(schema, args) {
	const validate = await loadSchemaValidator();
	if (validate === null) return;
	const violations = validate(schema, args, '');
	if (violations.length === 0) return;
	throw new ChartError(
		`参数不符合 schema：\n- ${violations.slice(0, 12).join('\n- ')}`
		+ (violations.length > 12 ? `\n- …共 ${violations.length} 项` : '')
		+ '\n字段名要完全一致，改完重交。',
	);
}

/** 取必填字符串，空串算缺。 */
function requireText(value, field) {
	if (typeof value !== 'string' || value.trim() === '') throw new ChartError(`${field} 缺失`);
	return value.trim();
}

/**
 * 校验成员交上来的方案：字段齐全、id 合法、连线两端存在。不查节点数量、入口、环。
 * @param {unknown} args chart_submit 的入参。
 * @returns {{id: string, name: string, nodes: Array<{id: string, title: string}>, edges: Array<{from: string, to: string}>, submittedAt: string}} 规整后的方案。
 */
export function validateSubmission(args) {
	const plan = args?.plan;
	if (plan === null || typeof plan !== 'object') throw new ChartError('plan 缺失');
	const id = requireText(plan.id, 'plan.id');
	const name = requireText(plan.name, 'plan.name');
	if (!ID_PATTERN.test(id)) throw new ChartError(`plan.id "${id}" 只能用 a-z、0-9 与短横，且以字母或数字开头`);
	if (id.length > ID_MAX) throw new ChartError(`plan.id 太长（${id.length} > ${ID_MAX}）`);

	const rawNodes = args.nodes;
	if (!Array.isArray(rawNodes) || rawNodes.length === 0) throw new ChartError('nodes 缺失或为空：至少要有一个节点');
	const nodes = [];
	const seen = new Set();
	for (const [index, node] of rawNodes.entries()) {
		if (node === null || typeof node !== 'object') throw new ChartError(`nodes[${index}] 不是对象`);
		const nodeId = requireText(node.id, `nodes[${index}].id`);
		const title = requireText(node.title, `nodes[${index}].title`);
		if (seen.has(nodeId)) throw new ChartError(`nodes[${index}].id "${nodeId}" 重复`);
		seen.add(nodeId);
		nodes.push({ id: nodeId, title });
	}

	const rawEdges = args.edges;
	if (!Array.isArray(rawEdges)) throw new ChartError('edges 缺失：没有先后关系就给空数组 []');
	const edges = [];
	for (const [index, edge] of rawEdges.entries()) {
		if (edge === null || typeof edge !== 'object') throw new ChartError(`edges[${index}] 不是对象`);
		const from = requireText(edge.from, `edges[${index}].from`);
		const to = requireText(edge.to, `edges[${index}].to`);
		if (!seen.has(from)) throw new ChartError(`edges[${index}].from 指向不存在的节点 "${from}"`);
		if (!seen.has(to)) throw new ChartError(`edges[${index}].to 指向不存在的节点 "${to}"`);
		edges.push({ from, to });
	}

	return { id, name, nodes, edges, submittedAt: new Date().toISOString() };
}

/**
 * 按 chart_update 的入参改一份状态（返回新对象，不改入参）。
 * @param {object} args chart_update 的入参。
 * @param {object} state 当前状态。
 * @returns {{state: object, changed: string[]}} 新状态与改了哪些字段。
 */
export function applyUpdate(args, state) {
	if (args === null || typeof args !== 'object') throw new ChartError('入参为空：至少给一个字段');
	const keys = Object.keys(args).filter((key) => args[key] !== undefined);
	if (keys.length === 0) {
		throw new ChartError('一个字段都没给：selectedChart / stage / next / members / nodes 至少给一个');
	}
	const next = {
		...state,
		members: state.members.map((member) => ({ ...member })),
		nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, { ...node }])),
		charts: { ...state.charts },
	};

	if (args.selectedChart !== undefined) {
		const id = requireText(args.selectedChart, 'selectedChart');
		if (!Object.hasOwn(state.charts, id)) {
			const known = Object.keys(state.charts);
			throw new ChartError(
				`selectedChart "${id}" 不在方案列表里`
				+ (known.length === 0 ? '（还没有任何方案：先让成员 chart_submit）' : `（现有：${known.join('、')}）`),
			);
		}
		next.selectedChart = id;
	}

	if (args.stage !== undefined) next.stage = requireText(args.stage, 'stage');
	if (args.next !== undefined) next.next = requireText(args.next, 'next');

	if (args.members !== undefined) {
		if (!Array.isArray(args.members)) throw new ChartError('members 必须是数组');
		next.members = args.members.map((member, index) => {
			if (member === null || typeof member !== 'object') throw new ChartError(`members[${index}] 不是对象`);
			const name = requireText(member.name, `members[${index}].name`);
			const status = member.status ?? '待办';
			if (!STATUSES.includes(status)) {
				throw new ChartError(`members[${index}].status "${status}" 不是 ${STATUSES.join(' / ')}`);
			}
			return { name, role: typeof member.role === 'string' ? member.role : '', status };
		});
	}

	if (args.nodes !== undefined) {
		const patch = args.nodes;
		if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new ChartError('nodes 必须是对象：{ "n1": { "status": "完成" } }');
		if (next.selectedChart === null) throw new ChartError('还没选中方案图：先 chart_update 传 selectedChart');
		for (const [id, change] of Object.entries(patch)) {
			if (!Object.hasOwn(next.nodes, id)) {
				const known = Object.keys(next.nodes);
				throw new ChartError(
					`nodes.${id} 不在选中图 "${next.selectedChart}" 里`
					+ (known.length === 0 ? '' : `（现有节点：${known.join('、')}）`),
				);
			}
			if (change === null || typeof change !== 'object' || Array.isArray(change)) throw new ChartError(`nodes.${id} 必须是对象`);
			if (change.status !== undefined) {
				if (!STATUSES.includes(change.status)) {
					throw new ChartError(`nodes.${id}.status "${change.status}" 不是 ${STATUSES.join(' / ')}`);
				}
				next.nodes[id].status = change.status;
			}
			if (change.title !== undefined) next.nodes[id].title = requireText(change.title, `nodes.${id}.title`);
		}
	}

	return { state: next, changed: keys };
}
