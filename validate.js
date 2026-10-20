/**
 * Structural validation for one submitted plan.
 *
 * The point of this module is that the METHOD is enforceable, not merely
 * requested: a plan that skips goal restatement, hard constraints, alternatives,
 * or verification cannot be submitted at all. Everything here is a pure
 * synchronous function over plain data, so it is directly testable without a
 * Harness.
 *
 * Two layers of enforcement exist and they are deliberately different:
 *
 *   - The tool's `parameters` JSON Schema rejects a wrong SHAPE (missing key,
 *     wrong type, bad enum) before `execute` ever runs.
 *   - This module rejects wrong CONTENT (blank text, too few risks, a task with
 *     no observable completion, a verification that names no command) because
 *     JSON Schema cannot express "this string must not be whitespace" or
 *     "this array must have at least one item whose text is meaningful".
 *
 * A rejection message names the exact path and the rule, because the model reads
 * it and must be able to repair the plan without guessing.
 *
 * @module dsh-method/validate
 */

/** Minimum number of tasks a plan must carry: a one-step plan is not a plan. */
export const MIN_TASKS = 2;

/** Minimum number of alternatives a plan must consider before choosing one. */
export const MIN_ALTERNATIVES = 2;

/** Minimum number of failure modes per task (`assumeReasons`). */
export const MIN_ASSUMPTIONS = 1;

/** Maximum characters allowed in a single-line field, to keep plans readable. */
export const MAX_FIELD_CHARS = 400;

/** Maximum characters allowed in a multi-line field. */
export const MAX_BLOCK_CHARS = 4000;

/** Task statuses, mirrored from the tool's parameter enum. */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];

/** Confidence levels a plan may declare for its own reversibility claim. */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

/**
 * Path-and-rule failure. `path` is the dotted location the model must repair,
 * e.g. `tasks[2].doneWhen`.
 */
export class PlanError extends Error {
	/**
	 * @param {string} path - dotted location of the offending field.
	 * @param {string} rule - what the field failed to satisfy.
	 */
	constructor(path, rule) {
		super(`${path}: ${rule}`);
		this.name = 'PlanError';
		this.path = path;
		this.rule = rule;
	}
}

/**
 * Assert a value is a non-blank string within a length bound.
 * @param {unknown} value - candidate.
 * @param {string} path - dotted location, for the error message.
 * @param {number} [max] - maximum allowed length.
 * @returns {string} the trimmed string.
 */
export function requireText(value, path, max = MAX_FIELD_CHARS) {
	if (typeof value !== 'string') throw new PlanError(path, `must be a string (got ${describe(value)})`);
	const text = value.trim();
	if (text === '') throw new PlanError(path, 'must not be blank');
	if (text.length > max) throw new PlanError(path, `must be at most ${max} characters (got ${text.length})`);
	return text;
}

/**
 * Assert a value is an array with at least `min` entries.
 * @param {unknown} value - candidate.
 * @param {string} path - dotted location.
 * @param {number} min - minimum length.
 * @returns {unknown[]} the array.
 */
export function requireArray(value, path, min) {
	if (!Array.isArray(value)) throw new PlanError(path, `must be an array (got ${describe(value)})`);
	if (value.length < min) {
		throw new PlanError(path, `must contain at least ${min} item${min === 1 ? '' : 's'} (got ${value.length})`);
	}
	return value;
}

/**
 * Assert a value is a plain object.
 * @param {unknown} value - candidate.
 * @param {string} path - dotted location.
 * @returns {Record<string, unknown>} the object.
 */
export function requireObject(value, path) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new PlanError(path, `must be an object (got ${describe(value)})`);
	}
	return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A short, safe description of a wrong value for an error message. Deliberately
 * does not JSON-stringify the value: it may be huge, and the model only needs to
 * know the type is wrong.
 * @param {unknown} value - the offending value.
 * @returns {string} a type description.
 */
function describe(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'string') return value.trim() === '' ? 'blank string' : 'string';
	return typeof value;
}

/**
 * Reject two entries that carry the same text, case- and space-insensitively.
 * Duplicated entries are how a plan pads itself to satisfy a minimum count
 * without doing the work, so the minimum is only real if duplicates fail.
 * @param {string[]} texts - already-trimmed entries.
 * @param {string} path - dotted location of the containing array.
 */
export function rejectDuplicates(texts, path) {
	const seen = new Map();
	for (const [index, text] of texts.entries()) {
		const key = text.toLowerCase().replace(/\s+/g, ' ');
		if (seen.has(key)) {
			throw new PlanError(
				`${path}[${index}]`,
				`duplicates ${path}[${seen.get(key)}]; each entry must be distinct`,
			);
		}
		seen.set(key, index);
	}
}

/**
 * Validate one task's completion criterion. A criterion the executor cannot
 * observe is not a criterion, so it must name a concrete command or an
 * observable state — this is checked structurally by requiring either a code
 * span, a slash-path, or a comparison operator rather than by trusting prose.
 * @param {string} doneWhen - the trimmed criterion.
 * @param {string} path - dotted location.
 * @returns {string} the criterion.
 */
export function requireObservableCompletion(doneWhen, path) {
	const hasCodeSpan = /`[^`]+`/.test(doneWhen);
	const hasCommand = /\b(?:npm|pnpm|yarn|node|npx|git|curl|bash|sh|python3?|pytest|vitest|jest|cargo|go|make|docker)\b/.test(doneWhen);
	// URLs are stripped before the path/file checks so a link ending in `.md` is not
	// read as a local artifact — a link is not something the executor checks on
	// disk. Stripping first also stops `//host/path.ext` from matching the path
	// rule through its protocol slashes.
	const withoutUrls = doneWhen.replace(/\bhttps?:\/\/\S+/gi, ' ');
	// A path counts when it carries a separator and an extension-like tail. No
	// whitespace is required on either side because the surrounding sentence is
	// usually Chinese and has no spaces at all.
	const hasPath = /(?:^|[^:\w])(?:\.{0,2}\/)?[\w.~-]+(?:\/[\w.~-]+)+\.[A-Za-z0-9]{1,8}\b/.test(withoutUrls);
	// A bare file name with a known artifact extension is equally observable: a
	// user checking "README.md exists" runs the same kind of check as a command.
	const hasBareFile = /(?:^|[^\w./])[\w.-]*\.(?:md|txt|json|ya?ml|toml|lock|csv|log|png|jpe?g|svg|pdf|ts|js|mjs|cjs|tsx|jsx|py|go|rs|java|c|h|cpp|sh|sql|html|css)\b/i.test(withoutUrls);
	const hasComparison = /(?:===?|!==?|>=?|<=?|返回|退出码|exit code|equals|matches)/.test(doneWhen);
	if (!hasCodeSpan && !hasCommand && !hasPath && !hasBareFile && !hasComparison) {
		throw new PlanError(
			path,
			'must name an observable check (a command, a file path, a quoted value, or a comparison) — '
			+ 'a criterion nobody can run is not a criterion',
		);
	}
	return doneWhen;
}

/**
 * Validate the goal block: one sentence of end state plus explicit
 * non-goals. Non-goals are mandatory because the most common failure of a
 * "universal" plan is silent scope creep.
 * @param {unknown} raw - the submitted `goal`.
 * @returns {{statement: string, nonGoals: string[]}} normalized goal.
 */
export function validateGoal(raw) {
	const goal = requireObject(raw, 'goal');
	const statement = requireText(goal.statement, 'goal.statement', MAX_BLOCK_CHARS);
	const nonGoals = requireArray(goal.nonGoals, 'goal.nonGoals', 1)
		.map((entry, index) => requireText(entry, `goal.nonGoals[${index}]`));
	rejectDuplicates(nonGoals, 'goal.nonGoals');
	return { statement, nonGoals };
}

/**
 * Validate the constraint list. At least one hard constraint is required: a plan
 * with no constraint has not understood its problem, and constraints are what
 * make a later verification checkable.
 * @param {unknown} raw - the submitted `constraints`.
 * @returns {Array<{text: string, kind: string}>} normalized constraints.
 */
export function validateConstraints(raw) {
	const list = requireArray(raw, 'constraints', 1);
	const kinds = new Set(['hard', 'soft']);
	const out = list.map((entry, index) => {
		const item = requireObject(entry, `constraints[${index}]`);
		const text = requireText(item.text, `constraints[${index}].text`);
		const kind = requireText(item.kind, `constraints[${index}].kind`);
		if (!kinds.has(kind)) {
			throw new PlanError(`constraints[${index}].kind`, `must be one of ${[...kinds].join(' | ')} (got ${JSON.stringify(kind)})`);
		}
		return { text, kind };
	});
	rejectDuplicates(out.map((item) => item.text), 'constraints');
	return out;
}

/**
 * Validate the alternatives block. A single-option plan is a decision made
 * without considering anything, which is exactly what this method exists to
 * prevent; the chosen option must also be one of the listed ones, so the plan
 * cannot quietly pick something it never weighed.
 * @param {unknown} raw - the submitted `alternatives`.
 * @returns {{options: Array<{name: string, pros: string, cons: string}>, chosen: string, reason: string}} normalized alternatives.
 */
export function validateAlternatives(raw) {
	const block = requireObject(raw, 'alternatives');
	const options = requireArray(block.options, 'alternatives.options', MIN_ALTERNATIVES).map((entry, index) => {
		const item = requireObject(entry, `alternatives.options[${index}]`);
		return {
			name: requireText(item.name, `alternatives.options[${index}].name`),
			pros: requireText(item.pros, `alternatives.options[${index}].pros`, MAX_BLOCK_CHARS),
			cons: requireText(item.cons, `alternatives.options[${index}].cons`, MAX_BLOCK_CHARS),
		};
	});
	rejectDuplicates(options.map((item) => item.name), 'alternatives.options');
	const chosen = requireText(block.chosen, 'alternatives.chosen');
	const match = options.find((item) => item.name.toLowerCase() === chosen.toLowerCase());
	if (match === undefined) {
		throw new PlanError(
			'alternatives.chosen',
			`must name one of alternatives.options (${options.map((item) => JSON.stringify(item.name)).join(', ')}); got ${JSON.stringify(chosen)}`,
		);
	}
	const reason = requireText(block.reason, 'alternatives.reason', MAX_BLOCK_CHARS);
	return { options, chosen: match.name, reason };
}

/**
 * Validate one task. Every task must carry: a verb phrase, why it is needed, what
 * it depends on, what could make it fail, and how completion is observed. The
 * dependency graph is validated as a whole afterwards, because a cycle can only
 * be seen across tasks.
 * @param {unknown} raw - one submitted task.
 * @param {number} index - its position, for error paths.
 * @returns {object} normalized task.
 */
export function validateTask(raw, index) {
	const path = `tasks[${index}]`;
	const task = requireObject(raw, path);
	const id = requireText(task.id, `${path}.id`);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new PlanError(`${path}.id`, 'must match [a-z0-9][a-z0-9-]* (lowercase, digits, hyphens)');
	}
	const status = requireText(task.status, `${path}.status`);
	if (!TASK_STATUSES.includes(status)) {
		throw new PlanError(`${path}.status`, `must be one of ${TASK_STATUSES.join(' | ')} (got ${JSON.stringify(status)})`);
	}
	const dependsOn = requireArray(task.dependsOn, `${path}.dependsOn`, 0)
		.map((entry, depIndex) => requireText(entry, `${path}.dependsOn[${depIndex}]`));
	rejectDuplicates(dependsOn, `${path}.dependsOn`);
	const assumeReasons = requireArray(task.assumeReasons, `${path}.assumeReasons`, MIN_ASSUMPTIONS)
		.map((entry, assumptionIndex) => requireText(entry, `${path}.assumeReasons[${assumptionIndex}]`, MAX_BLOCK_CHARS));
	rejectDuplicates(assumeReasons, `${path}.assumeReasons`);
	const doneWhen = requireObservableCompletion(requireText(task.doneWhen, `${path}.doneWhen`, MAX_BLOCK_CHARS), `${path}.doneWhen`);
	const artifacts = requireArray(task.artifacts, `${path}.artifacts`, 0)
		.map((entry, artifactIndex) => requireText(entry, `${path}.artifacts[${artifactIndex}]`));
	rejectDuplicates(artifacts, `${path}.artifacts`);
	return {
		id,
		title: requireText(task.title, `${path}.title`),
		status,
		dependsOn,
		assumeReasons,
		doneWhen,
		artifacts,
	};
}

/**
 * Validate the dependency graph: unique ids, every edge resolving, and no cycle.
 * A cycle is reported with the cycle path so the model can see which edge to cut.
 * @param {Array<{id: string, dependsOn: string[]}>} tasks - normalized tasks.
 */
export function validateGraph(tasks) {
	rejectDuplicates(tasks.map((task) => task.id), 'tasks');
	const byId = new Map(tasks.map((task) => [task.id, task]));
	for (const [index, task] of tasks.entries()) {
		for (const [depIndex, dependency] of task.dependsOn.entries()) {
			if (!byId.has(dependency)) {
				throw new PlanError(
					`tasks[${index}].dependsOn[${depIndex}]`,
					`references unknown task ${JSON.stringify(dependency)}; known ids: ${[...byId.keys()].join(', ')}`,
				);
			}
			if (dependency === task.id) {
				throw new PlanError(`tasks[${index}].dependsOn[${depIndex}]`, 'a task cannot depend on itself');
			}
		}
	}

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map(tasks.map((task) => [task.id, WHITE]));
	const stack = [];

	/**
	 * Depth-first search that reports the first back edge as a cycle.
	 * @param {string} id - task currently being visited.
	 */
	function visit(id) {
		color.set(id, GRAY);
		stack.push(id);
		for (const dependency of byId.get(id).dependsOn) {
			const state = color.get(dependency);
			if (state === GRAY) {
				const cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
				throw new PlanError('tasks', `dependency cycle: ${cycle.join(' → ')}`);
			}
			if (state === WHITE) visit(dependency);
		}
		stack.pop();
		color.set(id, BLACK);
	}

	for (const task of tasks) {
		if (color.get(task.id) === WHITE) visit(task.id);
	}
}

/**
 * Validate the verification block: each check must be runnable, and every task
 * must be covered — either by a check naming it or by a check that names no
 * task and therefore covers the whole plan. Coverage is what stops a plan from
 * listing steps whose success nobody ever confirms.
 * @param {unknown} raw - the submitted `verification`.
 * @param {Array<{id: string}>} tasks - normalized tasks.
 * @returns {Array<{task: string, check: string, expected: string}>} normalized checks.
 */
export function validateVerification(raw, tasks) {
	const list = requireArray(raw, 'verification', 1);
	const ids = new Set(tasks.map((task) => task.id));
	const checks = list.map((entry, index) => {
		const item = requireObject(entry, `verification[${index}]`);
		const task = requireText(item.task, `verification[${index}].task`);
		if (task !== '*' && !ids.has(task)) {
			throw new PlanError(
				`verification[${index}].task`,
				`must be "*" or one of ${[...ids].join(', ')} (got ${JSON.stringify(task)})`,
			);
		}
		return {
			task,
			check: requireText(item.check, `verification[${index}].check`, MAX_BLOCK_CHARS),
			expected: requireText(item.expected, `verification[${index}].expected`, MAX_BLOCK_CHARS),
		};
	});

	const covered = new Set(checks.map((check) => check.task).filter((task) => task !== '*'));
	if (!covered.has('*') && checks.some((check) => check.task === '*')) covered.add('*');
	const hasGlobal = checks.some((check) => check.task === '*');
	const uncovered = tasks.map((task) => task.id).filter((id) => !hasGlobal && !covered.has(id));
	if (uncovered.length > 0) {
		throw new PlanError(
			'verification',
			`no check covers ${uncovered.join(', ')}; add a check per task or one "*" check covering the whole plan`,
		);
	}
	return checks;
}

/**
 * Validate the whole plan and return its normalized form. This is the single
 * entry point the tool calls; it throws the first {@link PlanError} it finds.
 *
 * The input is the tool's full argument object (`{ plan: {...} }`), not the inner
 * plan, because the argument root is what the model actually sends and what the
 * schema validates. Taking the same shape here keeps the two layers aligned.
 * @param {unknown} raw - the model-supplied arguments.
 * @returns {object} the normalized plan.
 */
export function validatePlan(raw) {
	const args = requireObject(raw, 'plan');
	const plan = requireObject(args.plan, 'plan');

	const goal = validateGoal(plan.goal);
	const constraints = validateConstraints(plan.constraints);
	const alternatives = validateAlternatives(plan.alternatives);

	const rawTasks = requireArray(plan.tasks, 'tasks', MIN_TASKS);
	const tasks = rawTasks.map((task, index) => validateTask(task, index));
	validateGraph(tasks);

	const verification = validateVerification(plan.verification, tasks);

	// `reversible` decides whether the plan may proceed without a human pause;
	// it must therefore be a deliberate judgement, not a default.
	if (typeof plan.reversible !== 'boolean') {
		throw new PlanError('reversible', `must be a boolean (got ${describe(plan.reversible)})`);
	}
	const confidence = requireText(plan.confidence, 'confidence');
	if (!CONFIDENCE_LEVELS.includes(confidence)) {
		throw new PlanError('confidence', `must be one of ${CONFIDENCE_LEVELS.join(' | ')} (got ${JSON.stringify(confidence)})`);
	}

	return {
		goal,
		constraints,
		alternatives,
		tasks,
		verification,
		reversible: plan.reversible,
		confidence,
	};
}

/**
 * Render a validated plan back to the model as the durable, human-readable
 * record it just committed to. The wording is imperative and structural: this
 * text is what the model re-reads on every later step, so it must restate the
 * contract rather than merely acknowledge the submission.
 * @param {object} plan - a plan returned by {@link validatePlan}.
 * @param {number} revision - 1-based revision number of this submission.
 * @returns {string} the rendered plan.
 */
export function renderPlan(plan, revision) {
	const lines = [];
	lines.push(`# 执行计划 revision ${revision}`);
	lines.push('');
	lines.push('## 目标');
	lines.push(plan.goal.statement);
	lines.push('');
	lines.push('## 不做（非目标）');
	for (const item of plan.goal.nonGoals) lines.push(`- ${item}`);
	lines.push('');
	lines.push('## 约束');
	for (const item of plan.constraints) lines.push(`- [${item.kind}] ${item.text}`);
	lines.push('');
	lines.push('## 方案比较');
	for (const option of plan.alternatives.options) {
		const mark = option.name === plan.alternatives.chosen ? '**（已选）**' : '';
		lines.push(`- ${option.name}${mark}`);
		lines.push(`  - 优点：${option.pros}`);
		lines.push(`  - 代价：${option.cons}`);
	}
	lines.push(`- 选择理由：${plan.alternatives.reason}`);
	lines.push('');
	lines.push('## 任务');
	for (const [index, task] of plan.tasks.entries()) {
		lines.push(`${index + 1}. [${task.status}] ${task.title}  \`id: ${task.id}\``);
		lines.push(`   - 依赖：${task.dependsOn.length === 0 ? '无' : task.dependsOn.join(', ')}`);
		lines.push(`   - 失败原因：${task.assumeReasons.join('；')}`);
		lines.push(`   - 完成判定：${task.doneWhen}`);
		if (task.artifacts.length > 0) lines.push(`   - 产出：${task.artifacts.join(', ')}`);
	}
	lines.push('');
	lines.push('## 验证');
	for (const check of plan.verification) {
		lines.push(`- [${check.task}] ${check.check} → 期望：${check.expected}`);
	}
	lines.push('');
	lines.push(`- 可逆：${plan.reversible ? '是' : '否'}`);
	lines.push(`- 置信度：${plan.confidence}`);
	lines.push('');
	lines.push('## 执行契约');
	lines.push('- 严格按任务顺序执行；改计划必须重新提交 `plan_submit`，不得边做边改。');
	lines.push('- 每个任务做完立刻用它的「完成判定」验证；不通过就停下报告，不得跳过。');
	lines.push('- 全部做完后逐条运行「验证」中的检查，把实际输出贴给用户，不要只说通过。');
	return lines.join('\n');
}
