/**
 * Self-test for dsh-method. Run with `node selftest.mjs`.
 *
 * Every assertion here executes real code — the validator, the projection fold,
 * and the renderer — rather than reading the source. The file is the executable
 * specification of "what a plan must contain", so a future change that quietly
 * relaxes a rule fails here instead of silently shipping.
 *
 * Checks are grouped: VALIDATION (what must be rejected / accepted), FOLD (state
 * restoration from a synthetic event stream), and RENDER (the model-facing text).
 */

import assert from 'node:assert/strict';

import { createMethodProjection, parsePlanArguments } from './state.js';
import { PlanError, renderPlan, validatePlan } from './validate.js';

/**
 * Assert a projection state is lossless JSON.
 *
 * This mirrors `snapshotJsonValue` in the harness: the projection cache serializes
 * unit state, so anything exotic (a Map, a Set, a class instance, undefined, a
 * cycle) makes the write fail and `flushSoft` swallows it as a warning. The check
 * is written out rather than imported so the test has no absolute-path dependency
 * on this machine's dsh installation, but it enforces the same rule: a JSON
 * round-trip must reproduce the value exactly.
 * @param {unknown} state - the projection state to check.
 * @param {string} label - context for the failure message.
 */
function assertLosslessJson(state, label) {
	let roundTripped;
	try {
		roundTripped = JSON.parse(JSON.stringify(state));
	} catch (error) {
		throw new Error(`${label}: state is not JSON-serializable (${error.message})`);
	}
	assert.deepEqual(
		roundTripped,
		state,
		`${label}: state must survive a JSON round-trip unchanged (a Map/Set/undefined breaks the projection checkpoint)`,
	);
	for (const value of Object.values(state)) {
		assert.notEqual(value?.constructor?.name, 'Map', `${label}: ${value?.constructor?.name} is not lossless JSON`);
		assert.notEqual(value?.constructor?.name, 'Set', `${label}: ${value?.constructor?.name} is not lossless JSON`);
	}
}

let passed = 0;
let failed = 0;

/**
 * Run one check.
 * @param {string} label - what is being asserted.
 * @param {() => void} body - the assertion body; throwing fails the check.
 */
function check(label, body) {
	try {
		body();
		passed++;
		console.log(`  ok   ${label}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${label}`);
		console.log(`       ${error.message.split('\n')[0]}`);
	}
}

/**
 * Assert that `body` throws a PlanError whose path matches `path`.
 * @param {() => void} body - the call expected to throw.
 * @param {string} path - expected `error.path`.
 * @param {string} [label] - optional extra context for the failure message.
 */
function rejects(body, path, label = '') {
	try {
		body();
	} catch (error) {
		assert.ok(error instanceof PlanError, `expected PlanError, got ${error?.constructor?.name}: ${error?.message}`);
		assert.equal(error.path, path, `expected path ${JSON.stringify(path)}, got ${JSON.stringify(error.path)}`);
		return;
	}
	throw new Error(`expected rejection at ${path}${label === '' ? '' : ` (${label})`}`);
}

/**
 * Build a minimal plan that passes every rule. Individual checks then mutate one
 * field, so a failure is attributable to that field alone.
 * @returns {object} a fresh, valid plan payload.
 */
function validPlan() {
	return {
		plan: {
			goal: {
				statement: '把项目的依赖锁文件升级到与 package.json 一致的状态。',
				nonGoals: ['不升级任何依赖的大版本', '不改动 CI 配置'],
			},
			constraints: [
				{ text: '必须在离线环境下完成', kind: 'hard' },
				{ text: '尽量少改动 lockfile 的无关条目', kind: 'soft' },
			],
			alternatives: {
				options: [
					{ name: '整包重装', pros: '一步到位，不容易漏', cons: '会顺带升级传递依赖，改动面大' },
					{ name: '按差异逐条修', pros: '改动面最小，可审阅', cons: '耗时，且可能漏掉间接依赖' },
				],
				chosen: '按差异逐条修',
				reason: '硬约束要求离线，整包重装需要联网解析；软约束也指向最小改动。',
			},
			tasks: [
				{
					id: 'inspect-drift',
					title: '列出 lockfile 与 package.json 的差异条目',
					status: 'pending',
					dependsOn: [],
					assumeReasons: ['pnpm 版本不一致时 --lockfile-only 的输出格式可能不同'],
					doneWhen: '运行 `pnpm install --lockfile-only --offline` 后 git diff 能列出全部差异文件',
					artifacts: [],
				},
				{
					id: 'apply-fix',
					title: '按差异逐条修正 lockfile',
					status: 'pending',
					dependsOn: ['inspect-drift'],
					assumeReasons: ['某些条目无法离线解析，需要回退到联网模式'],
					doneWhen: '`pnpm install --frozen-lockfile --offline` 退出码为 0',
					artifacts: ['pnpm-lock.yaml'],
				},
			],
			verification: [
				{ task: 'inspect-drift', check: 'git diff --stat pnpm-lock.yaml', expected: '输出非空，且只涉及预期的包' },
				{ task: 'apply-fix', check: 'pnpm install --frozen-lockfile --offline', expected: '退出码 0，无 ERR_PNPM 报错' },
			],
			reversible: true,
			confidence: 'medium',
		},
	};
}

/**
 * Deep-clone a plan so each check mutates its own copy.
 * @param {object} value - plan payload.
 * @returns {object} a clone.
 */
function clone(value) {
	return structuredClone(value);
}

console.log('\n接受合法计划');
check('最小合法计划通过校验', () => {
	const plan = validatePlan(validPlan());
	assert.equal(plan.tasks.length, 2);
	assert.equal(plan.alternatives.chosen, '按差异逐条修');
	assert.equal(plan.revision, undefined, 'validatePlan must not invent a revision');
});

check('任务多于最小值也通过', () => {
	const payload = validPlan();
	payload.plan.tasks.push({
		id: 'final-check',
		title: '最终全量验证',
		status: 'pending',
		dependsOn: ['apply-fix'],
		assumeReasons: ['离线缓存缺失会导致失败'],
		doneWhen: '`pnpm install --frozen-lockfile` 退出码为 0',
		artifacts: [],
	});
	payload.plan.verification.push({ task: 'final-check', check: 'pnpm install --frozen-lockfile', expected: '退出码 0' });
	const plan = validatePlan(payload);
	assert.equal(plan.tasks.length, 3);
});

check('单个 "*" 验证项可覆盖全部任务', () => {
	const payload = validPlan();
	payload.plan.verification = [{ task: '*', check: '`pnpm build` 退出码为 0', expected: '退出码为 0，无 warning' }];
	const plan = validatePlan(payload);
	assert.equal(plan.verification.length, 1);
});

console.log('\n拒绝结构缺陷');
check('缺少目标被拒绝', () => {
	const payload = validPlan();
	delete payload.plan.goal;
	rejects(() => validatePlan(payload), 'goal');
});

check('目标为空串被拒绝', () => {
	const payload = validPlan();
	payload.plan.goal.statement = '   ';
	rejects(() => validatePlan(payload), 'goal.statement');
});

check('没有非目标被拒绝', () => {
	const payload = validPlan();
	payload.plan.goal.nonGoals = [];
	rejects(() => validatePlan(payload), 'goal.nonGoals');
});

check('非目标重复被拒绝', () => {
	const payload = validPlan();
	payload.plan.goal.nonGoals = ['不改 CI', '不改 ci'];
	rejects(() => validatePlan(payload), 'goal.nonGoals[1]');
});

check('没有约束被拒绝', () => {
	const payload = validPlan();
	payload.plan.constraints = [];
	rejects(() => validatePlan(payload), 'constraints');
});

check('约束 kind 非法被拒绝', () => {
	const payload = validPlan();
	payload.plan.constraints[0].kind = 'maybe';
	rejects(() => validatePlan(payload), 'constraints[0].kind');
});

check('只有一个方案被拒绝', () => {
	const payload = validPlan();
	payload.plan.alternatives.options = [payload.plan.alternatives.options[0]];
	payload.plan.alternatives.chosen = payload.plan.alternatives.options[0].name;
	rejects(() => validatePlan(payload), 'alternatives.options');
});

check('方案名重复被拒绝', () => {
	const payload = validPlan();
	payload.plan.alternatives.options[1].name = payload.plan.alternatives.options[0].name;
	payload.plan.alternatives.chosen = payload.plan.alternatives.options[0].name;
	rejects(() => validatePlan(payload), 'alternatives.options[1]');
});

check('选择的方案不在候选里被拒绝', () => {
	const payload = validPlan();
	payload.plan.alternatives.chosen = '第三个方案';
	rejects(() => validatePlan(payload), 'alternatives.chosen');
});

check('选择理由为空被拒绝', () => {
	const payload = validPlan();
	payload.plan.alternatives.reason = '';
	rejects(() => validatePlan(payload), 'alternatives.reason');
});

check('只有一个任务被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks = [payload.plan.tasks[0]];
	payload.plan.verification = [{ task: 'inspect-drift', check: 'ls', expected: '有输出' }];
	rejects(() => validatePlan(payload), 'tasks');
});

check('任务 id 非法被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0].id = 'Inspect Drift';
	payload.plan.verification[0].task = 'Inspect Drift';
	rejects(() => validatePlan(payload), 'tasks[0].id');
});

check('任务 status 非法被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0].status = 'doing';
	rejects(() => validatePlan(payload), 'tasks[0].status');
});

check('没有失败假设被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0].assumeReasons = [];
	rejects(() => validatePlan(payload), 'tasks[0].assumeReasons');
});

check('完成判定不可观察被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0].doneWhen = '确认一切正常';
	rejects(() => validatePlan(payload), 'tasks[0].doneWhen');
});

check('完成判定可为文件路径', () => {
	const payload = validPlan();
	payload.plan.tasks[0].doneWhen = 'docs/plan.md 存在且非空';
	const plan = validatePlan(payload);
	assert.ok(plan.tasks[0].doneWhen.includes('docs/plan.md'));
});

check('完成判定可为裸文件名', () => {
	const payload = validPlan();
	payload.plan.tasks[0].doneWhen = 'README.md 已更新';
	assert.ok(validatePlan(payload).tasks[0].doneWhen.includes('README.md'));
});

check('完成判定可为退出码比较', () => {
	const payload = validPlan();
	payload.plan.tasks[0].doneWhen = '构建退出码为 0';
	assert.ok(validatePlan(payload).tasks[0].doneWhen.includes('退出码'));
});

check('非技术领域的可观察判定被接受（旅行规划）', () => {
	for (const criterion of [
		'收到航空公司的订票确认邮件，含订单号',
		'收到酒店预订确认邮件',
		'行程单.pdf 已生成',
		'合同已签署',
	]) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		assert.ok(validatePlan(payload).tasks[0].doneWhen === criterion, `should accept ${criterion}`);
	}
});

check('非技术领域的可观察判定被接受（报告交付）', () => {
	for (const criterion of [
		'report/q3.docx 存在且不少于 20 页',
		'收到三位评审人的书面意见',
		'报告已发送给张总',
		'页面能打开',
	]) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		assert.ok(validatePlan(payload).tasks[0].doneWhen === criterion, `should accept ${criterion}`);
	}
});

check('反引号包裹空话不能绕过（BUG-4）', () => {
	for (const criterion of ['`确认一切正常`', '`好`', '``', '「完成」']) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		rejects(() => validatePlan(payload), 'tasks[0].doneWhen', criterion);
	}
});

check('英文散文里的歧义命令词不能绕过（BUG-4）', () => {
	for (const criterion of ['make it happen', 'go', 'sh', '返回', '把结果返回给用户']) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		rejects(() => validatePlan(payload), 'tasks[0].doneWhen', criterion);
	}
});

check('URL 不能靠自身符号或裸域名绕过（BUG-5）', () => {
	for (const criterion of ['<https://a.com/x.md>', '见 example.com/notes.md', '文档见 https://a.com']) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		rejects(() => validatePlan(payload), 'tasks[0].doneWhen', criterion);
	}
});

check('人的验收类判定被接受（BUG-1 修正后的正向覆盖）', () => {
	for (const criterion of [
		'客户在验收单上签字',
		'样机通过跌落测试',
		'医生确认体检报告无异常项',
	]) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		assert.ok(validatePlan(payload).tasks[0].doneWhen === criterion, `should accept ${criterion}`);
	}
});

check('无数值无产物的空话被拒绝', () => {
	for (const criterion of ['确认一切正常', '完成', '继续努力', '看看效果如何', '努力做好']) {
		const payload = validPlan();
		payload.plan.tasks[0].doneWhen = criterion;
		rejects(() => validatePlan(payload), 'tasks[0].doneWhen', criterion);
	}
});

check('仅凭 URL 不构成可观察判定', () => {
	const payload = validPlan();
	payload.plan.tasks[0].doneWhen = '见 https://example.com/notes.md 的说明';
	rejects(() => validatePlan(payload), 'tasks[0].doneWhen');
});

console.log('\n拒绝依赖图缺陷');
check('依赖指向不存在的任务被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[1].dependsOn = ['not-exist'];
	rejects(() => validatePlan(payload), 'tasks[1].dependsOn[0]');
});

check('任务依赖自己被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[1].dependsOn = ['apply-fix'];
	rejects(() => validatePlan(payload), 'tasks[1].dependsOn[0]');
});

check('依赖成环被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0].dependsOn = ['apply-fix'];
	rejects(() => validatePlan(payload), 'tasks');
});

check('三元环被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks.push({
		id: 'third',
		title: '第三',
		status: 'pending',
		dependsOn: ['apply-fix'],
		assumeReasons: ['可能失败'],
		doneWhen: '`ls` 退出码为 0',
		artifacts: [],
	});
	payload.plan.tasks[0].dependsOn = ['third'];
	payload.plan.verification.push({ task: 'third', check: 'ls', expected: '退出码 0' });
	rejects(() => validatePlan(payload), 'tasks');
});

check('任务 id 重复被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[1].id = 'inspect-drift';
	rejects(() => validatePlan(payload), 'tasks[1]');
});

console.log('\n拒绝验证缺陷');
check('验证列表为空被拒绝', () => {
	const payload = validPlan();
	payload.plan.verification = [];
	rejects(() => validatePlan(payload), 'verification');
});

check('有任务没被验证覆盖被拒绝', () => {
	const payload = validPlan();
	payload.plan.verification = [payload.plan.verification[0]];
	rejects(() => validatePlan(payload), 'verification');
});

check('验证指向不存在的任务被拒绝', () => {
	const payload = validPlan();
	payload.plan.verification[0].task = 'ghost';
	rejects(() => validatePlan(payload), 'verification[0].task');
});

check('验证期望为空被拒绝', () => {
	const payload = validPlan();
	payload.plan.verification[0].expected = '';
	rejects(() => validatePlan(payload), 'verification[0].expected');
});

console.log('\n拒绝元信息缺陷');
check('reversible 非布尔被拒绝', () => {
	const payload = validPlan();
	payload.plan.reversible = 'yes';
	rejects(() => validatePlan(payload), 'reversible');
});

check('confidence 非法被拒绝', () => {
	const payload = validPlan();
	payload.plan.confidence = 'certain';
	rejects(() => validatePlan(payload), 'confidence');
});

console.log('\n边界');
check('字段超长被拒绝', () => {
	const payload = validPlan();
	payload.plan.goal.statement = 'x'.repeat(4001);
	rejects(() => validatePlan(payload), 'goal.statement');
});

check('MAX_FIELD_CHARS=400 的边界（单行字段）', () => {
	const payload = validPlan();
	payload.plan.tasks[0].title = 'x'.repeat(401);
	rejects(() => validatePlan(payload), 'tasks[0].title');
	const ok = validPlan();
	ok.plan.tasks[0].title = 'y'.repeat(400);
	assert.equal(validatePlan(ok).tasks[0].title.length, 400, 'exactly at the limit must pass');
});

check('requireText 拒绝非字符串', () => {
	const payload = validPlan();
	payload.plan.goal.statement = 42;
	rejects(() => validatePlan(payload), 'goal.statement');
	const asArray = validPlan();
	asArray.plan.alternatives.reason = ['not', 'a', 'string'];
	rejects(() => validatePlan(asArray), 'alternatives.reason');
});

check('requireObject 拒绝数组', () => {
	const payload = validPlan();
	payload.plan.alternatives = [];
	rejects(() => validatePlan(payload), 'alternatives');
	const taskAsArray = validPlan();
	taskAsArray.plan.tasks[1] = [];
	rejects(() => validatePlan(taskAsArray), 'tasks[1]');
});

check('requireObject 拒绝 null 与基本类型', () => {
	for (const bad of [null, 7, 'str', true]) {
		const payload = validPlan();
		payload.plan.constraints[0] = bad;
		rejects(() => validatePlan(payload), 'constraints[0]');
	}
});

check('null 输入被拒绝', () => {
	rejects(() => validatePlan(null), 'arguments');
});

check('数组输入被拒绝', () => {
	rejects(() => validatePlan([]), 'arguments');
});

check('错误路径能区分外层与内层（BUG-3）', () => {
	// Missing wrapper names `plan`; a broken wrapper names `arguments`. A model
	// reading the message must be able to tell which level to repair.
	let outer;
	try { validatePlan({}); } catch (error) { outer = error.path; }
	assert.equal(outer, 'plan');
	let inner;
	try { validatePlan(null); } catch (error) { inner = error.path; }
	assert.equal(inner, 'arguments');
	let wrongType;
	try { validatePlan({ plan: [] }); } catch (error) { wrongType = error.path; }
	assert.equal(wrongType, 'plan');
});

check('非对象任务被拒绝', () => {
	const payload = validPlan();
	payload.plan.tasks[0] = 'inspect';
	rejects(() => validatePlan(payload), 'tasks[0]');
});

console.log('\n投影状态必须是无损 JSON（投影缓存契约）');
check('每个折叠阶段的 state 都能 JSON 往返', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	assertLosslessJson(state, 'init');

	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: '', commandId: 'c1' } });
	assertLosslessJson(state, 'after command/run');

	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
	assertLosslessJson(state, 'after command/done');

	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 'A', arguments: JSON.stringify(validPlan()) } });
	assertLosslessJson(state, 'after tool/call (pending populated)');

	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 'B', arguments: JSON.stringify(validPlan()) } });
	assertLosslessJson(state, 'after a second concurrent tool/call');

	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 'A', isError: false } } });
	assertLosslessJson(state, 'after tool/result (plan committed)');
});

check('pending 是普通对象而不是 Map', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	const state = projection.init();
	assert.equal(Object.getPrototypeOf(state.pending), Object.prototype, 'pending must be a plain record');
	assert.equal(state.pending.constructor, Object);
});

check('stateSchema.parse 的输出也是无损 JSON', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	const parsed = projection.stateSchema.parse({
		active: true,
		running: null,
		pending: { A: '{}' },
		plan: { goal: { statement: 'x' } },
		revision: 2,
	});
	assertLosslessJson(parsed, 'stateSchema.parse output');
});

console.log('\n投影折叠');
check('初始状态为未激活', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	const state = projection.init();
	assert.equal(state.active, false);
	assert.equal(state.revision, 0);
	assert.equal(state.plan, null);
});

check('/method 后、command/done 前即为激活', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: '', commandId: 'c1' } });
	assert.equal(state.running.wanted, true);
	assert.equal(state.active, false, 'commit happens on command/done');
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
	assert.equal(state.active, true);
	assert.equal(state.running, null);
});

check('/method off 后取消激活', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: '', commandId: 'c1' } });
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: 'off', commandId: 'c2' } });
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c2', kind: 'success' } });
	assert.equal(state.active, false);
});

check('命令失败不改变激活状态', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: '', commandId: 'c1' } });
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'error' } });
	assert.equal(state.active, false);
	assert.equal(state.running, null);
});

check('成功的 plan_submit 提交计划并递增 revision', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'command/run', data: { name: 'method', args: '', commandId: 'c1' } });
	state = projection.apply(state, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
	const payload = validPlan();
	state = projection.apply(state, {
		type: 'tool/call',
		data: { name: 'plan_submit', callId: 't1', arguments: JSON.stringify(payload) },
	});
	assert.ok(Object.hasOwn(state.pending, 't1'));
	state = projection.apply(state, {
		type: 'tool/result',
		data: { message: { toolCallId: 't1', isError: false } },
	});
	assert.equal(state.revision, 1);
	assert.equal(state.plan.goal.statement, payload.plan.goal.statement);
	assert.equal(Object.keys(state.pending).length, 0);
});

check('失败的 plan_submit 不提交', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, {
		type: 'tool/call',
		data: { name: 'plan_submit', callId: 't1', arguments: '{}' },
	});
	state = projection.apply(state, {
		type: 'tool/result',
		data: { message: { toolCallId: 't1', isError: true } },
	});
	assert.equal(state.revision, 0);
	assert.equal(state.plan, null);
});

check('第二次提交递增到 revision 2 并覆盖内容', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	const first = validPlan();
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't1', arguments: JSON.stringify(first) } });
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't1', isError: false } } });
	const second = validPlan();
	second.plan.goal.statement = '第二版目标';
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't2', arguments: JSON.stringify(second) } });
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't2', isError: false } } });
	assert.equal(state.revision, 2);
	assert.equal(state.plan.goal.statement, '第二版目标');
});

check('其他工具的事件被忽略', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	const before = state;
	state = projection.apply(state, { type: 'tool/call', data: { name: 'bash', callId: 'x', arguments: '{}' } });
	assert.equal(state, before, 'unrelated tool calls must return the same reference');
});

check('并发两个 plan_submit 各自配对', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	const first = validPlan();
	const second = validPlan();
	second.plan.goal.statement = '第二份并发计划';
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't1', arguments: JSON.stringify(first) } });
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't2', arguments: JSON.stringify(second) } });
	assert.equal(Object.keys(state.pending).length, 2, 'both calls must stay pending');
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't1', isError: false } } });
	assert.equal(state.revision, 1, 'first result must commit its own plan');
	assert.equal(state.plan.goal.statement, first.plan.goal.statement);
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't2', isError: false } } });
	assert.equal(state.revision, 2, 'second result must not be lost');
	assert.equal(state.plan.goal.statement, '第二份并发计划');
	assert.equal(Object.keys(state.pending).length, 0);
});

check('并发中失败的那个不提交、也不影响另一个', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't1', arguments: JSON.stringify(validPlan()) } });
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't2', arguments: JSON.stringify(validPlan()) } });
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't1', isError: true } } });
	assert.equal(state.revision, 0);
	assert.equal(Object.keys(state.pending).length, 1, 'the failed call leaves, the live one stays');
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 't2', isError: false } } });
	assert.equal(state.revision, 1);
});

check('乱序 tool/result 被忽略', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	let state = projection.init();
	state = projection.apply(state, { type: 'tool/call', data: { name: 'plan_submit', callId: 't1', arguments: '{"plan":{}}' } });
	state = projection.apply(state, { type: 'tool/result', data: { message: { toolCallId: 'other', isError: false } } });
	assert.ok(Object.hasOwn(state.pending, 't1'), 'an unrelated result must not clear the pending call');
	assert.equal(state.revision, 0);
});

check('stateSchema 拒绝损坏的缓存行', () => {
	const projection = createMethodProjection('method', 'plan_submit');
	assert.throws(() => projection.stateSchema.parse(null), TypeError);
	assert.throws(() => projection.stateSchema.parse({ active: 'yes' }), TypeError);
	assert.throws(() => projection.stateSchema.parse({ active: true, running: { commandId: 1, wanted: true } }), TypeError);
	const ok = projection.stateSchema.parse({ active: true, running: null });
	assert.equal(ok.active, true);
	assert.equal(ok.revision, 0);
});

check('parsePlanArguments 容错', () => {
	assert.equal(parsePlanArguments('not json'), null);
	assert.equal(parsePlanArguments('null'), null);
	assert.equal(parsePlanArguments('[]'), null);
	assert.equal(parsePlanArguments('{"plan":[]}'), null);
	assert.deepEqual(parsePlanArguments('{"plan":{"a":1}}'), { a: 1 });
});

console.log('\n渲染');
check('渲染包含全部必需段落', () => {
	const plan = validatePlan(validPlan());
	const text = renderPlan(plan, 1);
	for (const heading of ['## 目标', '## 不做（非目标）', '## 约束', '## 方案比较', '## 任务', '## 验证', '## 执行契约']) {
		assert.ok(text.includes(heading), `missing ${heading}`);
	}
	assert.ok(text.includes('revision 1'));
	assert.ok(text.includes('**（已选）**'), 'chosen option must be marked');
	assert.ok(text.includes('inspect-drift'));
});

check('渲染标记第二版 revision', () => {
	const plan = validatePlan(validPlan());
	assert.ok(renderPlan(plan, 7).includes('revision 7'));
});

check('渲染包含可逆与置信度', () => {
	const plan = validatePlan(validPlan());
	const text = renderPlan(plan, 1);
	assert.ok(text.includes('可逆：是'));
	assert.ok(text.includes('置信度：medium'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
