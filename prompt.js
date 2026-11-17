/**
 * 编排模式注入到系统提示词的那一段。
 *
 * 这一段只写「主对话在这里是什么角色、路怎么走」；派谁、派几个、顺序、要不要审查都不写死，
 * 由主对话按场景判断。
 *
 * @module dsh-method/prompt
 */

/** 提示词段在系统提示词里的名字。 */
export const PROMPT_SECTION_NAME = 'orchestrate:policy';

/**
 * 调度者提示词。
 * @param {object} options 环境事实。
 * @param {boolean} options.hasTeam 团队子代理工具是否可用。
 * @param {boolean} options.hasTodo 待办工具是否可用。
 * @param {string} options.plansDir 方案存档目录。
 * @param {string} options.statePath 状态文件路径。
 * @param {object} options.chart 当前选中的方案：name、nodes（已按连线顺序）、done、total。
 * @param {string} options.stage 当前阶段。
 * @param {string} options.next 下一步。
 * @param {Array} options.members 成员清单。
 * @returns {string} 提示词正文。
 */
export function dispatchPolicy({ hasTeam, hasTodo, plansDir, statePath, chart, stage, next, members }) {
	const dispatch = hasTeam
		? '派活用 spawn_teammate：成员之间能直接对话，你不用替他们转达。'
		: '团队子代理没开：派活用 subagent 或 subagent_fork，成员之间不能直接对话，要你中转。';
	const lines = [
		'# 编排模式：你是调度者',
		'',
		'你现在是这件事的调度者。你的职能只有两件：给任务路由模型，给任务调度成员。具体活由成员干。',
		'',
		'## 派活',
		'- ' + dispatch,
		'- 派谁、派几个、先派谁、要不要审查，都由你按这次的实际场景判断，没有固定流程。',
		'- 派之前把职责、边界、交付物写清楚；一件事派给一个人，别两个人抢同一份活。',
		'- 能选模型时按任务挑 provider 与 model；选不了就用默认模型。',
		'- 成员回报不够就换人、加派、改职责重派；够了就交给下一环节或收口。',
		'',
		'## 方案',
		'- 需要方案时，让出方案的成员调 chart_submit 交：方案名、节点（第几步做什么）、连线（谁在谁后面）。一个方案就是一条路径。',
		'- 你比较候选方案，用 chart_update 的 selectedChart 选中一张；没被选中的留在 ' + plansDir + ' 里备查。',
		'- 一条路走不通：换一个已交的方案，或重派成员出新路径。',
	];
	const chartText = renderChart({ chart, stage, next, members });
	if (chartText !== '') lines.push('', chartText);
	lines.push(
		'',
		'## 进度',
		'- 节点状态只有四种：待办 / 进行中 / 完成 / 失败。节点全亮就是这件事做完了，由你收口交给用户。',
		'- 每次收到成员回报，调 chart_update 更新节点状态、阶段、下一步、成员清单。',
		'- 状态写在 ' + statePath + '，下一轮的提示词与待办都从这里读。',
		'',
		'## 你不做的事',
		'- 你不自己改项目文件：写代码、改配置、写文档、跑命令，都派给成员。',
		'- 你手上确实有读写工具，但那是给你查资料用的；用它们改东西会收到一条警告——警告不拦你，活也会照做，但那就说明这活该派出去。',
		'- 你不替成员写方案，方案由出方案的成员自己交。',
	);
	if (hasTodo === true) lines.splice(lines.indexOf('## 进度'), 0, ...todoSection());
	return lines.join('\n');
}

/**
 * 待办那一段：节点怎么变成 todo_write 的一项。
 * @returns {string[]} 提示词行。
 */
function todoSection() {
	return [
		'## 待办',
		'- 当前方案就是这个回合的待办清单：用 todo_write 写一份，一个方案一处，不要另起题目。',
		'- 每项两个字段：content 写「节点 id + 空格 + 节点标题」（标题可能重名，带上 id 才不会重复），status 只取 pending / in_progress / completed 之一。',
		'- 节点状态换成 status：完成 → completed，进行中 → in_progress，待办和失败 → pending。',
		'- 顺序照方案里的节点顺序；todo_write 是整份替换，每次给全量。',
		'- 每轮开工先对一遍这份待办，收到成员回报、调完 chart_update 之后再对一遍。',
		'',
	];
}

/**
 * 把当前方案排成一段文字，每轮都跟着提示词走。
 * @param {object} options chart、stage、next、members。
 * @returns {string} 没有方案时给空串。
 */
function renderChart({ chart, stage, next, members }) {
	if (chart === undefined || chart === null || chart.nodes.length === 0) return '';
	const lines = ['## 当前方案：' + (chart.name === '' ? chart.id : chart.name) + '（' + chart.done + '/' + chart.total + ' 完成）'];
	if (typeof stage === 'string' && stage !== '') lines.push('- 阶段：' + stage);
	if (typeof next === 'string' && next !== '') lines.push('- 下一步：' + next);
	lines.push('- 节点：');
	for (const node of chart.nodes) lines.push('  - [' + node.status + '] ' + node.id + ' ' + node.title);
	if (Array.isArray(members) && members.length > 0) {
		lines.push('- 成员：');
		for (const member of members) lines.push('  - ' + member.name + '（' + (member.role === '' ? '未写职责' : member.role) + '）' + member.status);
	}
	lines.push('- 更新进度用 chart_update，节点 id 就是上面这些。');
	return lines.join('\n');
}

/** 开启时的回执。 */
export function enteredNotice(hasTeam) {
	return hasTeam
		? '编排模式已开启：你是调度者，成员之间可以直接对话。说清这次要做的事。'
		: '编排模式已开启：团队子代理没开，派活回退到普通子代理，成员之间由你中转。说清这次要做的事。';
}

/** 关闭时的回执。 */
export function leftNotice() {
	return '编排模式已关闭：提示词段已撤下，进度还留在 .orchestrate 里。';
}

/** 主对话自己写文件时的那条警告。 */
export function writeWarning(toolName) {
	return `这条活该派给成员：你在编排模式里是调度者。刚才的 ${toolName} 照常执行了，本次不拦；下次同类改动交给成员做。`;
}

/** chart_submit 的工具说明。 */
export function submitToolDescription() {
	return '交出你这条路的方案：节点写这一步做什么，连线写谁在谁后面。主对话会比较几个方案选一个执行。单步方案就交一个节点、edges 给空数组。';
}

/** chart_update 的工具说明。 */
export function updateToolDescription() {
	return '调度者专用：选中方案、写当前阶段与下一步、维护成员清单、按节点 id 点亮进度。节点状态只有 待办 / 进行中 / 完成 / 失败。';
}
