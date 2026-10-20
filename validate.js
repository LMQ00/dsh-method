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
	// The question is NOT "does this look technical". A travel plan's criterion
	// "收到航空公司的订票确认邮件，含订单号" and a report plan's "收到三位评审人的
	// 书面意见" are perfectly observable to a human — they name an artifact someone
	// can look at. Judging only by code-shaped signals (commands, diffs, exit
	// codes) silently makes this plugin a programming tool, which defeats its whole
	// purpose. So the test is: does the criterion name something that can be
	// SEEN — an artifact, a state, a value, or a third-party acknowledgement?
	// A code span counts only when it holds something checkable: at least 2 chars
	// and not pure Chinese prose. Otherwise "`确认一切正常`" would pass by wrapping
	// a vague sentence in backticks, which is the cheapest possible bypass.
	const hasCodeSpan = [...doneWhen.matchAll(/([\u0060])([^\u0060]+)\1/g)].some(([, , inner]) => {
		const body = inner.trim();
		if (body.length < 2) return false;
		const cjk = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
		// Predominantly Chinese text inside backticks is prose, not a symbol/value.
		return cjk * 2 <= body.length;
	});
	// Only unambiguous executable names count. `go`, `sh`, and `make` were removed:
	// they are ordinary words in English prose ("make it happen", "go ahead"), and
	// `sh` is two letters, so keeping them let nearly any sentence qualify.
	const hasCommand = /\b(?:npm|pnpm|yarn|npx|git|curl|wget|bash|zsh|python3?|pytest|vitest|jest|cargo|docker|kubectl|terraform|ansible|gradle|maven|msbuild)\b/.test(doneWhen);

	// URLs are stripped before the path/file checks so a link ending in `.md` is not
	// read as an artifact — a link is not something the executor checks on disk.
	// Stripping first also stops `//host/path.ext` from matching the path rule
	// through its protocol slashes.
	const withoutUrls = doneWhen.replace(/\bhttps?:\/\/\S+/gi, ' ');

	// A local path or bare file name: an artifact on disk.
	const hasPath = /(?:^|[^:\w.@])(?:\.{0,2}\/)[\w.~-]+(?:\/[\w.~-]+)*\.[A-Za-z0-9]{1,8}\b|(?:^|[^:\w.@])[\w.~-]+(?:\/[\w.~-]+)+\.[A-Za-z0-9]{1,8}\b/.test(withoutUrls)
		&& !/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|cn|co|ai|app|xyz)(?:\/|\b)/i.test(withoutUrls);
	const hasBareFile = /(?:^|[^\w./])[\w.-]*\.(?:md|txt|json|ya?ml|toml|lock|csv|log|png|jpe?g|svg|gif|pdf|docx?|xlsx?|pptx?|odt|ods|epub|mp[34]|mov|zip|tar|gz|eml|ics|ts|js|mjs|cjs|tsx|jsx|py|go|rs|java|c|h|cpp|sh|sql|html|css)\b/i.test(withoutUrls);

	// A numeric or ordering comparison: "> 80%", "≤ 3 条", "至少 20 页".
	// Evaluated against `withoutUrls`: a URL's own `=`, `>`, and query string must
	// not satisfy this rule. Four spellings of "returns" were cut down to the
	// measurable forms, because bare 返回 matched any sentence mentioning a return.
	// Only comparisons between an actual value and something else count. A bare `<`
	// or `>` used as an angle bracket (`<https://…>`) must not satisfy this, so each
	// operator has to be followed by an operand.
	const hasComparison = /(?:===?|!==?|≥|≤)(?:\s*[\w"'\u0060\u300c])|(?:>=?|<=?)\s*[\d\w]|(?:不超过|至少|不少于|不多于|大于|小于|等于)\s*[\d\w]|(?:退出码|返回码|返回值|状态码)为|[\u4e00-\u9fff\w]+\s*为\s*(?:true|false|null|\d+|[\u201c"'\u300c][^\u201d"'\u300d]+[\u201d"'\u300d]|[\w-]+)/.test(withoutUrls);

	// A threshold with a unit: "20 页", "3 条记录", "95 分", "8000 元".
	const hasQuantity = /\d+\s*(?:页|条|行|个|份|项|次|人|天|小时|分钟|元|块|%|％|分|条记录|字|篇|张|台|套|件)/.test(doneWhen);

	// A concrete value that can be compared: a quoted string, a number, a version.
	// A bare number or version is a checkable value. Quoted text counts only when it
	// is not predominantly Chinese prose: "「完成」" is a vague word in quote marks,
	// not a value somebody can compare against.
	const hasQuoted = [...doneWhen.matchAll(/[\u0060"\u201c'\u300c]([^\u0060"\u201d'\u300d]{2,})[\u0060"\u201d'\u300d]/g)]
		.some(([, body]) => {
			const text = body.trim();
			const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
			return cjk * 2 <= text.length;
		});
	const hasValue = hasQuoted || /\bv?\d+(?:\.\d+)+\b|\b\d+\b/.test(doneWhen);

	// An artifact named in prose WITHOUT an extension, which is the common case in
	// non-technical domains: 邮件 / 订单号 / 报告 / 回执 / 签字 / 截图 / 确认函.
	// This list is deliberately about verifiable deliverables, not domain jargon:
	// every entry names something a person can look at to decide "done".
	const hasArtifactNoun = /(?:邮件|电邮|回执|收据|发票|合同|订单|确认函|确认书|通知|报告|文档|文件|表格|清单|名单|方案|纪要|记录|截图|照片|录音|录像|链接|网址|二维码|签名|签字|盖章|盖章版|交付物|附件|反馈|意见|评审|审批|回复|答复|凭证|票据|行程单|预约|确认码|验证码|编号|序列号)/.test(doneWhen)
		// "文档见 <url>" / "文档在 <url>" point at a document elsewhere; that is a
		// reference, not an artifact this plan produces, so it must not qualify on
		// the noun alone.
		&& !/(?:文档|文件|记录|报告|链接|网址)\s*(?:见|在|位于)/.test(doneWhen)

	// An explicit state change a human can confirm: 存在 / 已生成 / 已提交 / 已完成.
	const hasStateChange = /(?:存在|已生成|已创建|已提交|已发出|已发送|已收到|收到|已完成|已通过|已批准|已签署|已上传|已发布|已确认|可以通过|能打开|能够打开|能正常|正常工作|正常运行|可访问|可用|做完了|跑通|通过(?:[\u4e00-\u9fff]{0,6})?(?:测试|验收|评审|检验|检测|验证|审查))/.test(doneWhen);

	if (
		!hasCodeSpan && !hasCommand && !hasPath && !hasBareFile
		&& !hasComparison && !hasQuantity && !hasValue
		&& !hasArtifactNoun && !hasStateChange
	) {
		throw new PlanError(
			path,
			'must name an observable completion — something a person can look at and decide done: '
			+ 'a command to run, a file or artifact to produce, a value to compare, or a state to confirm. '
			+ 'Rejected because it names no artifact, value, or checkable state.',
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
			// A check nobody can perform is not a check: it must name something runnable
			// or observable, by the same rule a task's completion criterion follows.
			check: requireObservableCompletion(
				requireText(item.check, `verification[${index}].check`, MAX_BLOCK_CHARS),
				`verification[${index}].check`,
			),
			expected: requireText(item.expected, `verification[${index}].expected`, MAX_BLOCK_CHARS),
		};
	});

	// One `*` check covers the whole plan, so it suppresses per-task coverage
	// requirements; otherwise every task id must appear.
	const hasGlobal = checks.some((check) => check.task === '*');
	const covered = new Set(checks.map((check) => check.task));
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
	// The two layers get distinct paths so a model that sent the inner plan without
	// the `{ plan: … }` wrapper sees `arguments` in the message and can tell which
	// level is wrong. Naming both `plan` made the error unactionable.
	const args = requireObject(raw, 'arguments');
	if (!Object.hasOwn(args, 'plan')) {
		throw new PlanError('plan', 'missing: the arguments must be an object of the form { plan: { … } }');
	}
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
