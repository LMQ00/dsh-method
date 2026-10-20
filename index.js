/**
 * dsh-method — a general-purpose method for the DeepSeek Harness.
 *
 * The mode is logged per-session collaboration state. While it is active, the
 * `method:policy` prompt section carries a domain-neutral planning protocol and
 * the `plan_submit` tool lands a plan whose STRUCTURE is enforced by schema plus
 * validator, not merely requested by prose.
 *
 * Enter and leave with `/method` and `/method off`. A bare `/method` only selects
 * the mode and submits no message of its own, so planning starts with whatever
 * the user writes next. State is a fold over the session log (`command/run` +
 * `command/done`, `tool/call` + `tool/result`), so resume, fork, and replay
 * restore it without a plugin-owned event type.
 *
 * Design intent, stated once here because every module depends on it:
 *
 *   The plan this mode produces is not the FASTEST plan, it is the most GENERAL
 *   one. Speed comes from skipping goal restatement, alternatives, constraints,
 *   and verification — which is exactly what makes a plan fail in an unfamiliar
 *   domain. So each of those is mandatory, and each is machine-checked.
 *
 * @module dsh-method
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import {
	PROMPT_SECTION_NAME,
	PLAN_TOOL_NAME,
	COMMAND_NAME,
	enteredNotice,
	methodPolicy,
	planToolDescription,
	revisedNotice,
} from './methodology.js';
import {
	PROJECTION_KEY,
	createMethodProjection,
	ensureParentDir,
	resolvePlanPath,
} from './state.js';
import { PlanError, renderPlan, validatePlan } from './validate.js';

export const name = 'method';

/**
 * `sessionProjections` is required: it is the only durable, fork-correct home for
 * the mode. `commands` is optional and read opportunistically, so the plugin
 * still activates in a composition without it (it just has no way in or out).
 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];

/** Bound on a `notice`-form context summary, mirroring the harness's own. */
const CONTEXT_SUMMARY_MAX_CHARS = 120;

/* ------------------------------------------------------------------ */
/* Message helpers                                                     */
/* ------------------------------------------------------------------ */

/** Deep-freeze a freshly built message the way the harness's factories do. */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}

/**
 * Build one identified, frozen user-role message. Inlined rather than imported so
 * this bundle declares no dependency on a shipped Harness package and keeps
 * resolving from the profile alone.
 * @param {Array<object>} content - content blocks.
 * @param {object} source - message source descriptor.
 * @returns {object} a frozen user message.
 */
function userMessage(content, source) {
	return deepFreeze({ id: randomUUID(), role: 'user', content, source });
}

/**
 * A `notice`-form context message: one line of account, shown without expanding
 * the row.
 * @param {string} text - full text for the model.
 * @param {string} [summary] - collapsed row label.
 * @returns {object} a frozen notice message.
 */
function noticeMessage(text, summary) {
	return userMessage([{ type: 'text', text }], {
		kind: 'method',
		form: 'notice',
		summary: String(summary ?? text).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_SUMMARY_MAX_CHARS),
	});
}

/* ------------------------------------------------------------------ */
/* Tool argument schema                                                */
/* ------------------------------------------------------------------ */

/**
 * The JSON Schema for `plan_submit`. It rejects a wrong SHAPE (missing key, wrong
 * type, out-of-enum value) before `execute` runs; the CONTENT rules that JSON
 * Schema cannot express live in `validate.js`.
 *
 * The schema is standard JSON Schema, NOT the `defineTool` DSL: `ctx.tools.register`
 * takes the raw schema straight to the provider, so requiredness is the standard
 * per-object `required: [...]` string array. Putting `required: true` on a
 * property — the DSL form — is rejected by the provider with
 * "Invalid schema for function 'plan_submit': true is not of type 'array'".
 *
 * The schema is intentionally verbose and fully described: the model reads it as
 * the specification of what "a plan" means here.
 * @returns {Record<string, unknown>} the parameter schema.
 */
function planParameters() {
	/** A required string property with a description. */
	const text = (description) => ({ type: 'string', description });
	/** A required string-enum property. */
	const choice = (values, description) => ({ type: 'string', enum: values, description });
	/** A required array-of-strings property. */
	const texts = (description) => ({ type: 'array', items: { type: 'string' }, description });
	/** An object property: explicit properties, explicit requiredness, sealed. */
	const object = (properties, required, description) => ({
		type: 'object',
		...(description === undefined ? {} : { description }),
		properties,
		required,
		additionalProperties: false,
	});
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			plan: object({
				goal: object(
					{
						statement: text('One sentence: the state that will exist when this is done. Be concrete and checkable.'),
						nonGoals: texts('At least one thing this work will NOT do. Naming these is what keeps scope from creeping.'),
					},
					['statement', 'nonGoals'],
					'What finishing looks like, and what is explicitly out of scope.',
				),
				constraints: {
					type: 'array',
					description: 'Facts that bound the solution: time, budget, environment, existing decisions that cannot change.',
					items: object(
						{
							text: text('The constraint itself.'),
							kind: choice(['hard', 'soft'], 'hard = violating it means failure; soft = negotiable.'),
						},
						['text', 'kind'],
					),
				},
				alternatives: object(
					{
						options: {
							type: 'array',
							description: 'At least two distinct approaches.',
							items: object(
								{
									name: text('Short name of the approach.'),
									pros: text('What this approach is good at.'),
									cons: text('What it costs or risks. Must be honest — an option with no downside is an unexamined option.'),
								},
								['name', 'pros', 'cons'],
							),
						},
						chosen: text('Must exactly match one of the option names.'),
						reason: text('Why this one wins given the constraints. Reference the constraints, not taste.'),
					},
					['options', 'chosen', 'reason'],
					'At least two approaches considered, and why one was chosen. A single option is a default, not a decision.',
				),
				tasks: {
					type: 'array',
					description: 'At least two ordered steps. Each must be independently completable and checkable.',
					items: object(
						{
							id: text('Stable lowercase id: [a-z0-9][a-z0-9-]*. Referenced by dependsOn and verification.'),
							title: text('Short imperative phrase naming the step.'),
							status: choice(
								['pending', 'in_progress', 'completed', 'skipped'],
								'Starting state of this step. Normally pending for every step at submission time.',
							),
							dependsOn: texts('Ids of steps that must complete first. Empty array for a starting step. No cycles allowed.'),
							assumeReasons: texts(
								'At least one way this step could fail or be blocked. Naming a failure does not cause it; not naming it hides it.',
							),
							doneWhen: text(
								'An OBSERVABLE completion check: a command to run, a file that must exist, a value that must match. Not "it works".',
							),
							artifacts: texts('Files, documents, or outputs this step produces. Empty array when the step produces nothing tangible.'),
						},
						['id', 'title', 'status', 'dependsOn', 'assumeReasons', 'doneWhen', 'artifacts'],
					),
				},
				verification: {
					type: 'array',
					description:
						'Checks that prove the whole plan worked. Every task must be covered by a check naming it, or by one check with task "*".',
					items: object(
						{
							task: text('A task id from this plan, or "*" for a check covering the whole result.'),
							check: text('The exact command or inspection to perform.'),
							expected: text('What the output must be for this to pass. Concrete, not "looks right".'),
						},
						['task', 'check', 'expected'],
					),
				},
				reversible: {
					type: 'boolean',
					description: 'Can every effect be undone? false means the user must confirm before execution.',
				},
				confidence: choice(
					['high', 'medium', 'low'],
					'Confidence that this plan achieves the goal given the constraints. Be honest; "medium" is a normal answer.',
				),
			}, [
				'goal',
				'constraints',
				'alternatives',
				'tasks',
				'verification',
				'reversible',
				'confidence',
			], 'The complete plan. A re-submission replaces the previous plan entirely.'),
		},
		required: ['plan'],
	};
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

/**
 * Plugin entry.
 * @param {object} ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
	/** Read this session's method projection state, or `undefined` when unregistered. */
	function stateOf(session) {
		try {
			return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
		} catch {
			return undefined;
		}
	}

	/**
	 * Whether the method is in effect for one session. `command/run` is appended
	 * BEFORE the handler executes, so a command that is still running has already
	 * recorded its selection and the pending value wins.
	 * @param {object} session - the session.
	 * @returns {boolean} true while the method is active.
	 */
	function isMethodActive(session) {
		const state = stateOf(session);
		if (state === undefined) return false;
		return state.running === null ? state.active === true : state.running.wanted === true;
	}

	/**
	 * Whether the method was already committed to the log, ignoring a selection
	 * this command is still carrying. A command handler asks this question, not
	 * {@link isMethodActive}: by the time it runs, its own `command/run` has already
	 * moved the effective state.
	 * @param {object} session - the session.
	 * @returns {boolean} true when the committed state is active.
	 */
	function loggedActive(session) {
		const state = stateOf(session);
		return state === undefined ? false : state.active === true;
	}

	/** The session's working directory, falling back to the host process cwd. */
	function sessionCwd(session) {
		try {
			const cwd = session.header?.cwd;
			if (typeof cwd === 'string' && cwd !== '') return cwd;
		} catch {
			// A session without readable metadata uses the process directory.
		}
		return process.cwd();
	}

	/** Absolute plan path for one session. */
	function planPathFor(session) {
		return resolvePlanPath(sessionCwd(session));
	}

	/* ---------------- durable state ---------------- */

	ctx.sessionProjections.register(createMethodProjection(COMMAND_NAME, PLAN_TOOL_NAME));

	/* ---------------- prompt ---------------- */

	ctx.systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
		text: (context) => {
			try {
				const agent = context.agent;
				if (agent === undefined) return '';
				if (!isMethodActive(agent.session)) return '';
				return methodPolicy(planPathFor(agent.session));
			} catch {
				// A provider that throws would break assembly; contribute nothing instead.
				return '';
			}
		},
	});

	/* ---------------- /method ---------------- */

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			definitionId: 'dsh-method',
			name: COMMAND_NAME,
			description: 'Method mode: 通用做事方法 — 任何非平凡任务先产出结构化执行计划（目标与非目标 / 约束 / 方案比较 / 可观察完成判定 / 覆盖式验证），结构由 schema 与校验器强制，再逐步执行',
			input: { hint: '[off]', attachments: false },
			handler: ({ agent, rawInput }) => {
				const session = agent.session;
				const message = rawInput.trim();

				if (message === 'off') {
					if (!loggedActive(session)) return { kind: 'success', text: 'Method mode 未开启。' };
					agent.inject(noticeMessage('用户关闭了 method mode。已提交的计划仍留在 .method/plan.md，但不再强制。', 'Method mode off'));
					return { kind: 'success', text: 'Method mode off.' };
				}

				// One collaboration mode at a time: plan mode owns the session while it is on.
				if (!loggedActive(session)) {
					const planMode = ctx.get('planMode');
					if (planMode !== undefined) {
						let planActive = false;
						try {
							planActive = planMode.get(agent)?.active === true;
						} catch {
							planActive = false;
						}
						if (planActive) return { kind: 'error', text: 'Exit plan mode first.' };
					}
				}

				// A bare `/method` is a silent mode toggle: it submits nothing, so the
				// protocol section is already in effect for the next turn.
				if (message === '') {
					agent.inject(noticeMessage(enteredNotice(), 'Method mode on'));
					return { kind: 'success', text: 'Method mode on. 直接说要做的事，我先产出结构化计划。' };
				}
				agent.steer(userMessage([{ type: 'text', text: message }], { kind: 'user' }));
				return { kind: 'success', text: 'Method mode on.' };
			},
		});
	});

	/* ---------------- plan_submit ---------------- */

	ctx.tools.register({
		name: PLAN_TOOL_NAME,
		description: planToolDescription(),
		parameters: planParameters(),
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					accepted: { type: 'boolean', const: true },
					revision: { type: 'integer' },
					planPath: { type: 'string' },
					taskCount: { type: 'integer' },
					rendered: { type: 'string' },
				},
				required: ['accepted', 'revision', 'planPath', 'taskCount', 'rendered'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text:
						`计划已接受（revision ${value.revision}，${value.taskCount} 个任务），已落盘：${value.planPath}\n\n`
						+ '现在按下列计划执行。每步完成后立刻用该步的「完成判定」验证；不通过就停下报告。\n\n'
						+ value.rendered,
				},
			],
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === undefined) {
				throw new Error(`${PLAN_TOOL_NAME} 需要一个调用它的 agent（没有会话可以落盘）`);
			}
			const session = agent.session;
			if (!isMethodActive(session)) {
				throw new Error(`${PLAN_TOOL_NAME} 只能在 method mode 中调用；先运行 /method 开启。`);
			}

			let plan;
			try {
				plan = validatePlan(args);
			} catch (error) {
				if (error instanceof PlanError) {
					// The message is the repair instruction: it names the path and the rule.
					throw new Error(`计划被拒绝 — ${error.message}\n修正该字段后重新提交完整计划。`);
				}
				throw error;
			}

			const state = stateOf(session);
			const revision = (state?.revision ?? 0) + 1;
			const planPath = planPathFor(session);
			const rendered = renderPlan(plan, revision);

			try {
				ensureParentDir(planPath);
				writeFileSync(planPath, `${rendered}\n`, 'utf8');
			} catch (error) {
				throw new Error(`计划校验通过但落盘失败（${planPath}）：${error?.message ?? error}`);
			}

			if (revision > 1) {
				agent.inject(noticeMessage(revisedNotice(revision), `Method: revision ${revision}`));
			}

			return {
				accepted: true,
				revision,
				planPath,
				taskCount: plan.tasks.length,
				rendered,
			};
		},
	});
}
