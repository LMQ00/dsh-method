/**
 * dsh-method —— 子代理编排插件。
 *
 * 用户敲 /orchestrate 之后，主对话只做两件事：路由模型与调度。派活走宿主自己的
 * spawn_teammate（团队子代理缺席时回退 subagent），成员交上来的方案图落成一张选中的图，
 * 之后主对话只点亮节点。进度写在项目根 .orchestrate/state.json，网页与手机面板读同一份。
 *
 * 主对话手上的读写工具不拦：它自己调写文件工具时，只回一条警告说明这活该派给成员。
 *
 * @module dsh-method
 */

import { randomUUID } from 'node:crypto';
import {
	PROMPT_SECTION_NAME,
	dispatchPolicy,
	enteredNotice,
	leftNotice,
	submitToolDescription,
	updateToolDescription,
	writeWarning,
} from './prompt.js';
import {
	STATUSES,
	archiveChart,
	defaultState,
	flattenChart,
	readState,
	resolvePlansDir,
	resolveStatePath,
	writeState,
} from './store.js';
import {
	CHART_SUBMIT_SCHEMA,
	CHART_UPDATE_SCHEMA,
	ChartError,
	applyUpdate,
	assertArgsMatchSchema,
	validateSubmission,
} from './schema.js';

export const name = 'method';

/** 宿主服务；commands 与 connection 是可选的，缺了插件照样能跑。 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];

/** 编辑器类工具名：主对话自己调这些才算「自己动手改东西」。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'create_file', 'str_replace_editor']);

/** 进入与关闭模式的命令名。 */
const COMMAND_NAME = 'orchestrate';

/** 两个工具的名字。 */
const SUBMIT_TOOL = 'chart_submit';
const UPDATE_TOOL = 'chart_update';

/** 会话投影的 key 与版本。 */
const PROJECTION_KEY = 'orchestrate';
const PROJECTION_VERSION = 1;

/** 读状态的路由：网页面板轮询它。 */
const STATE_ROUTE = '/api/orchestrate.state';

/** 折叠出的模式状态里，那条命令带来的选择。 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 模式投影：只认 command/run 与 command/done，不造事件类型。
 * @returns {object} 投影定义。
 */
function createModeProjection() {
	return {
		key: PROJECTION_KEY,
		stateVersion: PROJECTION_VERSION,
		stateSchema: {
			parse(value) {
				if (!isPlainObject(value)) throw new TypeError('orchestrate projection state must be an object');
				if (typeof value.active !== 'boolean') throw new TypeError('orchestrate projection state.active must be a boolean');
				const running = value.running;
				if (running !== undefined && running !== null) {
					if (!isPlainObject(running) || typeof running.commandId !== 'string' || typeof running.wanted !== 'boolean') {
						throw new TypeError('orchestrate projection state.running must be { commandId, wanted } or null');
					}
				}
				return {
					active: value.active,
					running: running === undefined || running === null ? null : { commandId: running.commandId, wanted: running.wanted },
				};
			},
		},
		init: () => ({ active: false, running: null }),
		apply(state, event) {
			if (!isPlainObject(event) || !isPlainObject(event.data)) return state;
			const data = event.data;
			if (event.type === 'command/run') {
				if (data.name !== COMMAND_NAME) return state;
				const args = typeof data.args === 'string' ? data.args : '';
				return { ...state, running: { commandId: String(data.commandId), wanted: args.trim() !== 'off' } };
			}
			if (event.type === 'command/done') {
				const running = state.running;
				if (running === null || data.commandId !== running.commandId) return state;
				if (data.kind !== 'success') return { ...state, running: null };
				return { ...state, active: running.wanted, running: null };
			}
			return state;
		},
	};
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

/** 冻结一条消息，跟宿主的工厂产出一致。 */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}

/** 一条 notice 形式的消息：模型看得见正文，界面折叠成一行。 */
function noticeMessage(text, summary) {
	return deepFreeze({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'method', form: 'notice', summary: String(summary ?? text).replace(/\s+/g, ' ').trim().slice(0, 120) },
	});
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 */
export function apply(ctx) {
	/** 最近一次被工具或命令触碰过的项目目录，读状态的路由没带 cwd 时用它。 */
	let lastProjectDir = process.cwd();

	/** 已经警告过的「会话 + 回合」，避免同一轮反复刷。 */
	const warnedTurns = new WeakMap();
	/** 每个会话当前回合号。 */
	const currentTurn = new WeakMap();

	/** 读这个会话的模式投影状态。 */
	function stateOf(session) {
		try {
			return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
		} catch {
			return undefined;
		}
	}

	/** 模式在这个会话里是否生效（把还在跑的那条命令的选择算进去）。 */
	function isActive(session) {
		const state = stateOf(session);
		if (state === undefined) return false;
		return state.running === null ? state.active === true : state.running.wanted === true;
	}

	/** 已经提交进日志的模式状态，命令处理器问这个。 */
	function loggedActive(session) {
		const state = stateOf(session);
		return state === undefined ? false : state.active === true;
	}

	/** 会话当前的工作目录（/cd 之后以投影为准）。 */
	function sessionCwd(session) {
		try {
			const projected = ctx.sessionProjections.stateOf(session, 'workingDirectory');
			if (typeof projected === 'string' && projected !== '') return projected;
		} catch {
			// 没有工作目录服务就退回会话头。
		}
		try {
			const cwd = session.header?.cwd;
			if (typeof cwd === 'string' && cwd !== '') return cwd;
		} catch {
			// 会话头读不到就用进程目录。
		}
		return process.cwd();
	}

	/** 团队子代理工具在不在。 */
	function hasTeamTools(agent) {
		try {
			return ctx.tools.get('spawn_teammate', agent) !== undefined;
		} catch {
			return false;
		}
	}

	/** 读状态前把项目目录记下来（读状态的路由要用）。 */
	function track(cwd) {
		lastProjectDir = cwd;
		return cwd;
	}

	/** 把 enabled 写进状态文件；写失败不打断命令。 */
	function setEnabled(cwd, enabled) {
		try {
			const { state } = readState(cwd);
			writeState(cwd, { ...state, enabled });
		} catch {
			// 状态目录不可写时，面板看不到，但模式本身照常开。
		}
	}

	/* ---------------- 模式状态 ---------------- */

	ctx.sessionProjections.register(createModeProjection());

	/* ---------------- 提示词 ---------------- */

	ctx.systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
		text: (context) => {
			try {
				const agent = context.agent;
				if (agent === undefined) return '';
				const session = agent.session;
				if (!isActive(session)) return '';
				const cwd = track(sessionCwd(session));
				return dispatchPolicy({
					hasTeam: hasTeamTools(agent),
					plansDir: resolvePlansDir(cwd),
					statePath: resolveStatePath(cwd),
				});
			} catch {
				// 提供者抛异常会让整次装配失败，只能贡献空串。
				return '';
			}
		},
	});

	/* ---------------- 自己动手时的警告 ---------------- */

	ctx.on('session/event', (session, event) => {
		if (event.type === 'turn/start') currentTurn.set(session, event.data.turn);
	});

	/**
	 * 主对话在模式里调写文件工具：回一条警告，不拦。
	 * @param {object} agent 调用方。
	 * @param {string} toolName 工具名。
	 */
	function warnSelfEdit(agent, toolName) {
		if (agent === undefined) return;
		const session = agent.session;
		// 子代理的会话模式是关的，天然收不到这条警告。
		if (!isActive(session)) return;
		const turn = currentTurn.get(session) ?? 0;
		if (warnedTurns.get(session) === turn) return;
		warnedTurns.set(session, turn);
		try {
			agent.inject(noticeMessage(writeWarning(toolName), '提示：这活该派给成员'));
		} catch {
			// 注入不进去不影响这次调用。
		}
	}

	ctx.on('tools/pre-execute', async (exec, next) => {
		if (WRITE_TOOLS.has(exec.name)) warnSelfEdit(exec.agent, exec.name);
		return next();
	});

	/* ---------------- /orchestrate ---------------- */

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			definitionId: 'dsh-method',
			name: COMMAND_NAME,
			description: '编排模式：主对话只做路由与调度，活派给子代理；成员交方案流程图，主对话选中并点亮进度，网页与手机面板看得到',
			input: { hint: '[off]', attachments: false },
			handler: ({ agent, rawInput }) => {
				const session = agent.session;
				const message = rawInput.trim();
				const cwd = track(sessionCwd(session));

				if (message === 'off') {
					if (!loggedActive(session)) return { kind: 'success', text: '编排模式没开着。' };
					setEnabled(cwd, false);
					agent.inject(noticeMessage(leftNotice(), '编排模式已关闭'));
					return { kind: 'success', text: '编排模式已关闭。' };
				}

				const team = hasTeamTools(agent);
				setEnabled(cwd, true);
				// 无参开启不合成消息：提示词段在下一轮装配里自然生效。
				if (message === '') {
					agent.inject(noticeMessage(enteredNotice(team), '编排模式已开启'));
					return { kind: 'success', text: enteredNotice(team) };
				}
				agent.steer(deepFreeze({
					id: randomUUID(),
					role: 'user',
					content: [{ type: 'text', text: message }],
					source: { kind: 'user' },
				}));
				return { kind: 'success', text: '编排模式已开启。' };
			},
		});
	});

	/* ---------------- chart_submit ---------------- */

	ctx.tools.register({
		name: SUBMIT_TOOL,
		description: submitToolDescription(),
		parameters: CHART_SUBMIT_SCHEMA,
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					accepted: { type: 'boolean', const: true },
					chartId: { type: 'string' },
					name: { type: 'string' },
					nodeCount: { type: 'integer' },
					edgeCount: { type: 'integer' },
					plansDir: { type: 'string' },
				},
				required: ['accepted', 'chartId', 'name', 'nodeCount', 'edgeCount', 'plansDir'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `方案「${value.name}」已收下（${value.chartId}，${value.nodeCount} 个节点、${value.edgeCount} 条连线），存档在 ${value.plansDir}。等主对话比较后选中。`,
			}],
		},
		async execute(args, exec) {
			await assertArgsMatchSchema(CHART_SUBMIT_SCHEMA, args);
			const agent = exec.agent;
			if (agent === undefined) throw new Error(`${SUBMIT_TOOL} 需要调用它的 agent`);
			const session = agent.session;
			if (!isActive(session)) throw new Error(`${SUBMIT_TOOL} 只能在编排模式里用；先让用户敲 /orchestrate。`);

			let chart;
			try {
				chart = validateSubmission(args);
			} catch (error) {
				if (error instanceof ChartError) throw new Error(`方案被拒：${error.message}。改完重交。`);
				throw error;
			}

			const cwd = track(sessionCwd(session));
			const { state } = readState(cwd);
			const nodes = { ...state.nodes };
			for (const node of chart.nodes) {
				if (!Object.hasOwn(nodes, node.id)) nodes[node.id] = { title: node.title, status: STATUSES[0] };
			}
			const next = {
				...state,
				enabled: true,
				nodes,
				charts: { ...state.charts, [chart.id]: chart },
			};
			try {
				archiveChart(cwd, chart);
				writeState(cwd, next);
			} catch (error) {
				throw new Error(`方案通过校验但落盘失败（${resolvePlansDir(cwd)}）：${error?.message ?? error}`);
			}
			return {
				accepted: true,
				chartId: chart.id,
				name: chart.name,
				nodeCount: chart.nodes.length,
				edgeCount: chart.edges.length,
				plansDir: resolvePlansDir(cwd),
			};
		},
	});

	/* ---------------- chart_update ---------------- */

	ctx.tools.register({
		name: UPDATE_TOOL,
		description: updateToolDescription(),
		parameters: CHART_UPDATE_SCHEMA,
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					updated: { type: 'boolean', const: true },
					revision: { type: 'integer' },
					selectedChart: { type: 'string' },
					stage: { type: 'string' },
					next: { type: 'string' },
					memberCount: { type: 'integer' },
					nodeCount: { type: 'integer' },
					statePath: { type: 'string' },
				},
				required: ['updated', 'revision', 'selectedChart', 'stage', 'next', 'memberCount', 'nodeCount', 'statePath'],
			},
			render: (_args, value) => {
				const flat = value.nodeCount === 0 ? '还没有选中图' : `${value.nodeCount} 个节点`;
				return [{
					type: 'text',
					text: `进度已更新（revision ${value.revision}）：选中图 ${value.selectedChart === '' ? '无' : value.selectedChart}，${flat}，${value.memberCount} 名成员。阶段：${value.stage === '' ? '未写' : value.stage}；下一步：${value.next === '' ? '未写' : value.next}。`,
				}];
			},
		},
		async execute(args, exec) {
			await assertArgsMatchSchema(CHART_UPDATE_SCHEMA, args);
			const agent = exec.agent;
			if (agent === undefined) throw new Error(`${UPDATE_TOOL} 需要调用它的 agent`);
			const session = agent.session;
			if (!isActive(session)) throw new Error(`${UPDATE_TOOL} 只能在编排模式里用；先敲 /orchestrate。`);

			const cwd = track(sessionCwd(session));
			const { state } = readState(cwd);
			let updated;
			try {
				updated = applyUpdate(args, state);
			} catch (error) {
				if (error instanceof ChartError) throw new Error(`更新被拒：${error.message}`);
				throw error;
			}

			let written;
			try {
				written = writeState(cwd, { ...updated.state, enabled: true });
			} catch (error) {
				throw new Error(`更新通过校验但落盘失败（${resolveStatePath(cwd)}）：${error?.message ?? error}`);
			}

			const flat = flattenChart(written.state);
			return {
				updated: true,
				revision: written.state.revision,
				selectedChart: written.state.selectedChart ?? '',
				stage: written.state.stage,
				next: written.state.next,
				memberCount: written.state.members.length,
				nodeCount: flat.nodes.length,
				statePath: written.path,
			};
		},
	});

	/* ---------------- 面板读状态的路由 ---------------- */

	ctx.inject(['connection'], (routeCtx) => {
		routeCtx.connection.fetch.register({
			path: STATE_ROUTE,
			methods: ['GET'],
			requestBody: 'buffered',
			fetch: async (request) => {
				const url = new URL(request.url, 'http://localhost');
				const asked = url.searchParams.get('cwd');
				const cwd = asked !== null && asked !== '' ? asked : lastProjectDir;
				const { state, broken, path } = readState(cwd);
				const body = {
					cwd,
					statePath: path,
					broken,
					enabled: state.enabled,
					selectedChart: state.selectedChart,
					stage: state.stage,
					next: state.next,
					members: state.members,
					charts: Object.values(state.charts).map((chart) => ({ id: chart.id, name: chart.name })),
					revision: state.revision,
					updatedAt: state.updatedAt,
					...flattenChart(state),
				};
				return Response.json(body, { headers: { 'cache-control': 'no-store' } });
			},
		});
	});
}

/** 导出给自测用的常量。 */
export const internals = { COMMAND_NAME, SUBMIT_TOOL, UPDATE_TOOL, PROJECTION_KEY, STATE_ROUTE, createModeProjection, defaultState };
