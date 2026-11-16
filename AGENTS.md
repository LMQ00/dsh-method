# AGENTS.md

## 索引

| 文档 | 类型 | 何时读 |
| --- | --- | --- |
| .spec/flows/overview.md | 图集入口 | 想知道这个插件整体怎么转、模块怎么衔接时 |
| .spec/flows/mode-enter.md | 图集 | 改命令、提示词段、团队工具回退时 |
| .spec/flows/dispatch.md | 图集 | 改派活规则、成员怎么被派出与回报时 |
| .spec/flows/chart-flow.md | 图集 | 改 chart_submit 校验、方案归档、选中逻辑时 |
| .spec/flows/progress.md | 图集 | 改 chart_update 字段、state.json 结构时 |
| .spec/flows/ui-panels.md | 图集 | 改网页或手机面板、动画、入口显隐时 |
| README.md | 说明 | 安装、用法、改它之前要知道的几条规矩 |

每份图集文件含：范围一行、mermaid 流程图、需求简报（目标 / 要做什么 / 验收 / 约束）。

## 文档规则

- 改代码前读对应那张图；改动让图与简报过时，先改图再改代码。
- 本文件只放索引与开发规范，不写现状、进度、待办、下一步、里程碑、变更记录；进度属于提交历史与对话。
- 文档只写结论与硬事实：删掉一句读者照做也不出错，就删。动机、背景、权衡、被否决方案不写，开场不铺引言、结尾不做总结。
- 一行一个结论，能进表格就进表格；同一件事只说一次，别处只给指针。
- 代码能不出就不出；只在读者要照着做时才给代码，每段都跟复现步骤。
- 表格列名用中文日常说法，不写 File / Key / Event 这类英文列名。
- 决策只记结论——定了什么、约束谁、怎么用。

## 代码规则

- 模式状态靠会话日志折叠得出（`command/run` + `command/done`），不自造事件类型：DSH 的持久化读路径会拒绝未知事件类型。
- 投影状态必须是无损 JSON：不能出现 Map、Set、undefined、类实例、循环引用；落盘遇到这些会拒整行。
- 改投影状态字段或折叠语义时，同步把状态版本号加一。
- 状态折叠对无关事件必须返回同一个状态引用；对任何输入都必须返回状态，不能抛。
- 进入命令无参时不得合成消息：提示词段落在下一轮装配里自然生效。
- 命令处理里不要用有效状态回答「这条命令进来之前是什么状态」；那个问题只能问已提交状态。
- 提示词段落的提供者不许抛异常：抛出去会让整个装配失败，只能贡献空串。
- `ctx.tools.register` 只校验输出 schema，`parameters` 原样透给 provider，`execute` 拿到裸入参。依赖参数形状的判断必须自己调 `validateJsonSchemaValue`，否则 `additionalProperties: false` 只是装饰。
- 工具参数 schema 用标准 JSON Schema，不用 `defineTool` 的 DSL：`register` 不接 DSL。
- 状态文件写盘用「写临时文件再 rename」，面板侧只在 rename 之后读得到完整 JSON。
- 不引宿主包；需要宿主工具时按等价实现内联，或从宿主安装目录运行期解析。

## 验证

- 改完纯逻辑模块后，在仓库根目录跑 `node selftest.mjs`，全部断言必须过。
- 改了 chart_submit / chart_update 的校验，必须双向验：应接受的、应拒绝的各跑一遍。
- 装进 profile 后跑 `dsh web --dump-config`，确认 0 条 `patch: entry not found` 告警，并确认本插件条目出现在合成配置里。
- 真实启动验证用 `dsh web --port 309x`（3080 是常用实例，不要占用），验完杀掉进程。
