/**
 * The method itself: the prompt text that turns a vague request into a bounded,
 * comparable, verifiable plan.
 *
 * The design constraint the user set is explicit: the plan this produces is NOT
 * the fastest one, it is the most GENERAL one — it must work for building a
 * feature, planning a trip, writing a report, or migrating a database. So the
 * text below contains no domain vocabulary. It states invariants that hold for
 * any undertaking, and it deliberately forbids the shortcuts that make a plan
 * fast but brittle:
 *
 *   - skipping the goal restatement → wrong task gets done confidently
 *   - skipping alternatives        → the first idea becomes the plan
 *   - skipping constraints         → scope creep discovered at the end
 *   - skipping failure assumptions → one surprise stops everything
 *   - skipping observable criteria → "done" is an opinion
 *
 * Everything the prompt asks for is *enforced* by `validate.js`, so the text is
 * not a wish. That division of labour is deliberate: prose explains WHY, the
 * schema and validator make it non-optional.
 *
 * @module dsh-method/methodology
 */

/** Section name this plugin contributes while the method is active. */
export const PROMPT_SECTION_NAME = 'method:policy';

/** Name of the model-facing tool that lands a plan. */
export const PLAN_TOOL_NAME = 'plan_submit';

/** The human command that enters and leaves the method. */
export const COMMAND_NAME = 'method';

/**
 * The system-prompt section injected while the method is active. It is rewritten
 * as one cohesive instruction because a model reading a policy in fragments
 * drops the fragments it finds inconvenient.
 * @param {string} planPath - absolute path of the plan file for this session.
 * @returns {string} the section text.
 */
export function methodPolicy(planPath) {
	return [
		'## 通用方法（method mode）',
		'',
		'当前处于 method mode。在这个模式下，任何非平凡工作都必须先产出一份结构化执行计划，',
		'通过 `plan_submit` 提交，再按计划逐步执行。计划不追求最快，追求**最普遍**——',
		'换一个领域、换一个人来执行，计划依然成立。',
		'',
		'### 计划必须回答的六件事',
		'',
		'1. **目标是什么，什么不算目标**。用一句话说清完成后的状态；再明确列出这次不做什么。',
		'   不写「不做」的计划，最后一定会悄悄扩大范围。',
		'2. **受什么约束**。时间、预算、环境、不可改动的既有事实。标出哪些是硬约束（违反就失败）',
		'   哪些是软约束（可协商）。',
		'3. **考虑过哪些方案，为什么选这个**。至少两个候选，各自写清优点与代价。',
		'   只有一个候选不叫决策，叫默认。',
		'4. **拆成哪些步骤**。每步一个小标题、一句「这一步为什么需要」、它依赖哪些前置步骤。',
		'   步骤之间不允许成环。',
		'5. **每步怎么算完成**。必须是一个能实际运行或实际观察的判定——跑一条命令、产出一个文件、',
		'   看到一个数值、收到一份书面确认、有人签字。写不出可观察判定的步骤，说明这一步还没想清楚。',
		'6. **怎么整体验证**。每个步骤都要被至少一条验证覆盖；验证要写清「跑什么」和「期望看到什么」。',
		'   不要写「确认功能正常」这种无法证伪的话。',
		'',
		'### 提交与执行',
		'',
		'- 计划通过 `plan_submit` 提交。结构由 schema 与校验器强制：缺字段、条目太少、',
		'  完成判定不可观察、依赖成环、验证没覆盖全部步骤，都会被直接拒绝并告诉你哪一项不合格。',
		'- 提交后计划会落盘到 `' + planPath + '`，同时把渲染好的全文回给你。',
		'- **之后严格按步骤执行**。每完成一步，立刻用该步的「完成判定」检查；不通过就停下报告，',
		'  不许跳过，也不许把失败说成完成。',
		'- 需要改计划时，重新调用 `plan_submit` 提交完整的新版本，不要在执行过程中私自改。',
		'- 全部完成后，逐条运行验证项，把**实际输出**贴出来，而不是只说「都通过了」。',
		'',
		'### 判断标准',
		'',
		'好计划的检验方法：把它交给另一个没有上下文的人，他能否照着执行、并在每一步自己判断',
		'是否做完。做不到就是计划还不够清楚，不是执行者的问题。',
		'',
	].join('\n');
}

/**
 * The context message injected when the method is switched on, telling the
 * session what just happened and what to do next.
 * @returns {string} the notice text.
 */
export function enteredNotice() {
	return 'method mode 已开启。任何非平凡任务现在都要先提交 `plan_submit` 计划；'
		+ '简单到只有一步的事（如直接回答一个问题）不需要。'
		+ '把要做的事说清楚，我先产出结构化计划。';
}

/**
 * The context message injected when a plan revision is accepted, so the session
 * notices a re-plan even when the tool result is collapsed in the UI.
 * @param {number} revision - the accepted revision number.
 * @returns {string} the notice text.
 */
export function revisedNotice(revision) {
	return `执行计划已更新到 revision ${revision}。后续步骤以最新一版为准，旧版本的步骤作废。`;
}

/**
 * Description of the `plan_submit` tool. Kept long on purpose: the model reads
 * this immediately before filling the schema, and it is the last place to
 * restate that a rejected plan must be repaired rather than resubmitted blindly.
 * @returns {string} the tool description.
 */
export function planToolDescription() {
	return '提交一份结构化执行计划（通用方法的标准产物）。适用任何领域：写代码、做调研、办活动、'
		+ '处理数据、写文档。计划必须包含目标与非目标、约束、至少两个方案及选择理由、'
		+ '至少两个有先后依赖的步骤、每个步骤可观察的完成判定、覆盖全部步骤的验证项。'
		+ '提交成功会落盘并把渲染后的计划回给你，之后必须严格按它执行。'
		+ '被拒绝时错误信息会指出具体字段，修好后重新提交完整计划（不是补丁）。';
}
