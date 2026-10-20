# dsh-method

给 DeepSeek Harness 一个**通用做事方法**：任何非平凡任务先产出结构化执行计划，计划的结构由 schema 与校验器强制，不是靠提示词请求。

产出的是**最普遍**的计划，不是最快的。换领域、换执行者仍然成立。

## 为什么

快的方法都靠省略：省掉目标澄清、省掉方案比较、省掉约束、省掉验证。这些省略在自己熟悉的领域看不出来，换到不熟悉的领域就变成返工。

这个插件把这几项变成**必填且机器校验**，所以模型省不掉。

## 装

```sh
dsh plugin --profile web add link:/path/to/dsh-method
```

或从 npm：

```sh
dsh plugin --profile web add dsh-method
```

装完重启 `dsh web`。profile 的 `node_modules` 里应有 `dsh-method` 软链——`link:` 装完若缺这条软链，`dsh web` 会打印 `cannot resolve profile bundle "dsh-method"` 并跳过该 bundle，重装一次即可。

## 用

```
/method            # 开启，直接说要做的事
/method off        # 关闭
```

开启后模型必须调用 `plan_submit` 提交计划。计划通过校验会落盘到 `<项目根>/.method/plan.md` 并把渲染后的全文回给模型，之后按计划执行。

## 计划被强制包含什么

| 项 | 规则 | 违反时 |
| --- | --- | --- |
| 目标 | 一句话说清完成后的状态 | 拒绝 |
| 非目标 | ≥1 条明确不做的 | 拒绝 |
| 约束 | ≥1 条，标 `hard` / `soft` | 拒绝 |
| 方案比较 | ≥2 个候选，各写优点与代价，选中项必须是其中之一 | 拒绝 |
| 任务 | ≥2 个，id 唯一，依赖不许成环 | 拒绝 |
| 每任务失败原因 | ≥1 条 | 拒绝 |
| 每任务完成判定 | 必须可观察：一条命令 / 一个文件路径 / 一个数值比较 | 拒绝 |
| 验证 | 每任务都被覆盖，或一条 `task: "*"` 覆盖整体 | 拒绝 |
| 可逆性 / 置信度 | 布尔 + `high\|medium\|low` | 拒绝 |

「可观察」的判定标准是结构化的：命令名（`npm`/`git`/`curl`…）、带扩展名的文件路径、或比较运算（`返回`/`退出码`/`>`）。`确认一切正常`、`页面能打开` 这类无法证伪的话会被拒绝。

## 两层强制

| 层 | 拒绝什么 | 在哪 |
| --- | --- | --- |
| JSON Schema | 形状错：缺字段、类型错、枚举非法、多余字段 | provider 侧，`execute` 之前 |
| `validate.js` | 内容错：空串、条目不够、判定不可观察、依赖成环、验证没覆盖 | `execute` 内 |

Schema 用标准 JSON Schema（`required` 是字符串数组），**不是** `defineTool` 的 DSL。用 DSL 写法（属性上 `required: true`）会被 provider 拒绝：`Invalid schema for function 'plan_submit': true is not of type 'array'`。

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：`/method` 命令、`plan_submit` 工具、`method:policy` 提示词段 |
| `validate.js` | 计划内容校验，纯函数 |
| `state.js` | 会话投影（从会话日志折叠状态）+ 计划路径解析 |
| `methodology.js` | 提示词文本 |
| `selftest.mjs` | 53 项自测，全部执行真实代码 |

## 状态怎么存

`sessionProjections` 从会话日志折叠，不自造事件类型——DSH 的持久化读路径会拒绝未知事件类型（除非带 `ignorable: true`，而 `Session.append()` 设不了）。

| 事件 | 作用 |
| --- | --- |
| `command/run`（`name: method`） | 记录待生效的选择 |
| `command/done`（配对 id） | `success` 才提交选择 |
| `tool/call`（`plan_submit`） | 按 `callId` 记下 `arguments` |
| `tool/result`（配对 id） | 非错误则解析该次的 `arguments` 并提交计划 |

待提交项是 **map 不是单值**，所以并行工具调用时每个 `plan_submit` 与自己的结果配对，不会互相抢。后完成的成功提交覆盖计划并递增 `revision`。

## 自测

```sh
node selftest.mjs
```

53 项，覆盖：合法计划接受、结构缺陷拒绝、依赖图缺陷拒绝、验证覆盖缺陷拒绝、元信息缺陷拒绝、边界（超长/`null`/非对象）、投影折叠（含并发与乱序）、渲染。

## 已知取舍

- **误报优于漏报**：`页面能打开`、`数据库中有 3 条记录` 这类判定会被拒绝。判定可观察性靠正则判断，宁可让模型改成写命令或写路径，也不放行无法证伪的话——放行会让整个验证环节形同虚设。
- **`.method/` 会进你的仓库**：计划落盘在项目根下。想忽略就在 `.gitignore` 加 `.method/`；本插件不自动改你的 `.gitignore`。
- **没有强制中断**：`plan_submit` 只在 method mode 下可用，但插件不阻止模型不调它就直接干活。真正要强制，得靠 `tools.guard` 拦截写操作——那是另一个量级的设计，当前版本刻意不做，避免变成「不开 method 就不能干活」。
