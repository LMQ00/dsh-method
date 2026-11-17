# dsh-method

DeepSeek Harness 的子代理编排插件。敲 `/orchestrate` 之后，主对话只做两件事：给任务路由模型、给任务调度成员；成员交方案（一串有序步骤），主对话选中一个、推进节点状态，并把节点写成对话里的待办。

## 装

```sh
dsh plugin --profile web add /path/to/dsh-method
```

改完代码重启引擎。

## 用

| 做什么 | 怎么用 |
| --- | --- |
| 开启 | `/orchestrate`，后面可以跟这次要做的事 |
| 关闭 | `/orchestrate off`。提示词段撤下，进度留在盘上 |
| 看进度 | 对话里的待办列表；要看原始数据就翻 .orchestrate/state.json |

主对话派活走宿主自己的 `spawn_teammate`；团队子代理没开时回退到 `subagent`，由主对话中转。派谁、派几个、要不要审查，都不写死。

模式开着时，系统提示词每轮都带着当前选中的方案：方案名与完成计数、阶段、下一步、按连线顺序排的节点与各自状态、成员清单。主对话不用去翻状态文件就知道走到哪一步。没有选中方案时不写这一段。

待办工具在的情况下，这段还要求主对话把节点写成 todo：顺序照方案，content 写「节点 id + 标题」（标题可能重名），status 取 `pending` / `in_progress` / `completed`，完成映射 completed、进行中映射 in_progress、待办和失败映射 pending。每轮开工对一遍，chart_update 之后再整份同步一遍。

主对话手上的读写工具不拦。它自己调 `write` / `edit` 这类工具时，插件回一条 notice 说明这活该派给成员，调用照常执行。成员写文件不触发警告。

## 两个工具

### chart_submit

出方案的成员用。一个方案就是一条路径。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `plan.id` | 字符串 | 方案 id，也是存档文件名：`[a-z0-9-]`，最多 40 字符 |
| `plan.name` | 字符串 | 方案显示名 |
| `nodes` | 数组 | `{ id, title }`，至少一个，id 方案内唯一 |
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

`status` 只有四个值：`待办` / `进行中` / `完成` / `失败`。没选中方案就改节点会被拒。

## 状态文件

项目根（最近的带 `.git` 的上级目录）下的 `.orchestrate/`：

| 文件 | 内容 |
| --- | --- |
| `state.json` | 选中方案、阶段、下一步、成员清单、节点状态、候选方案索引 |
| `plans/<id>.json` | 成员提交的原始方案 |
| `.gitignore` | 内容为 `*`，让 `git status` 保持干净 |

状态只能通过这两个工具写。写盘是「临时文件 + rename」。

## 验证

```sh
node selftest.mjs                     # 纯逻辑与宿主接线，假 ctx
dsh web --dump-config | grep dsh-method   # 0 条 patch 告警
dsh web --port 3091                   # 起一遍，验完杀掉
```

改 `chart_submit` / `chart_update` 的校验，要双向验：该收的、该拒的各跑一遍。
