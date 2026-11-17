# dsh-method

DeepSeek Harness 的子代理编排插件。敲 `/orchestrate` 之后，主对话只做两件事：给任务路由模型、给任务调度成员；成员交方案流程图，主对话选中一张、点亮节点，网页和手机面板看同一份进度。

## 装

```sh
dsh plugin --profile web add /path/to/dsh-method
```

改完代码：宿主侧（index.js、store.js、schema.js、prompt.js）重启引擎；客户端（client.js）刷新页面。

## 用

| 做什么 | 怎么用 |
| --- | --- |
| 开启 | `/orchestrate`，后面可以跟这次要做的事 |
| 关闭 | `/orchestrate off`。提示词段撤下、面板入口隐藏，进度留在盘上 |
| 看进度 | 网页会话头部的「编排」图标，点开是右侧栏的编排标签页；手机 App 对话详情页「插件」页签的「编排」面板 |

主对话派活走宿主自己的 `spawn_teammate`；团队子代理没开时回退到 `subagent`，由主对话中转。派谁、派几个、要不要审查，都不写死。

主对话手上的读写工具不拦。它自己调 `write` / `edit` 这类工具时，插件回一条 notice 说明这活该派给成员，调用照常执行。成员写文件不触发警告。

## 两个工具

### chart_submit

出方案的成员用。一张图就是一份方案。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `plan.id` | 字符串 | 方案 id，也是存档文件名：`[a-z0-9-]`，最多 40 字符 |
| `plan.name` | 字符串 | 方案显示名 |
| `nodes` | 数组 | `{ id, title }`，至少一个，id 图内唯一 |
| `edges` | 数组 | `{ from, to }`，两端必须出现在 nodes 里；单步方案给 `[]` |

只校验字段齐全与连线引用，不查节点数量、不查唯一入口、不查环。被拒时报错点名缺哪项。

### chart_update

主对话用，一次可以改四类东西，至少给一项。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `selectedChart` | 字符串 | 必须是已交上来的方案 id |
| `stage` | 字符串 | 当前阶段，一句话 |
| `next` | 字符串 | 下一步等什么，一句话 |
| `members` | 数组 | `{ name, role?, status? }`，整份替换 |
| `nodes` | 对象 | `{ "n1": { "status": "完成" } }`，只写要改的节点 |

`status` 只有四个值：`待办` / `进行中` / `完成` / `失败`。没选中图就改节点会被拒。

## 状态文件

项目根（最近的带 `.git` 的上级目录）下的 `.orchestrate/`：

| 文件 | 内容 |
| --- | --- |
| `state.json` | 选中图、阶段、下一步、成员清单、节点状态、候选方案索引 |
| `plans/<id>.json` | 成员提交的原始方案 |
| `.gitignore` | 内容为 `*`，让 `git status` 保持干净 |

状态只能通过这两个工具写。写盘是「临时文件 + rename」。

同一份内容会镜像到 `$DSH_HOME/dsh-go/orchestrate/mirror.json`，手机 App 的原生面板读它。

## 网页面板

`client.js` 是手写的客户端 bundle：`window.__ModuleLoader__.load({ id, factory })`，factory 里 `require('react')`。

它按会话所在的项目目录问状态：先读会话的工作目录投影，退到会话清单里的 cwd，带 `?cwd=` 请求 `/api/orchestrate.state`。每个项目一条轮询，没人看就停。

图标进的是 `conversation.session.header.utilities`，只在这个项目开着编排时出现；点开的是右侧栏标签页（`sidebar.right.pane.tab`，kind `orchestrate`），按钮再点一次收起。

图用 SVG 自绘：按连线分层布局，当前节点呼吸高亮、完成节点打勾、新节点进场动画、光点沿连线流动；`prefers-reduced-motion` 时关掉动画。

## 验证

```sh
node selftest.mjs                     # 纯逻辑与宿主接线，假 ctx
dsh web --dump-config | grep dsh-method   # 0 条 patch 告警
dsh web --port 3091                   # 起一遍，验完杀掉
```

改 `chart_submit` / `chart_update` 的校验，要双向验：该收的、该拒的各跑一遍。
