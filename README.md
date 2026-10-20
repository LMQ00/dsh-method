# dsh-method

给 DeepSeek Harness 一个**通用做事方法**：任何非平凡任务先产出结构化执行计划，计划的结构由 schema 与校验器强制，不是靠提示词请求。

产出的是**最普遍**的计划，不是最快的。换领域、换执行者仍然成立。

## 为什么

快的方法都靠省略：省掉目标澄清、省掉方案比较、省掉约束、省掉验证。这些省略在自己熟悉的领域看不出来，换到不熟悉的领域就变成返工。

这个插件把这几项变成**必填且机器校验**，所以模型省不掉。

## 装

本仓库**未发布到 npm**，只能从源码 clone 后以链接方式安装：

```sh
git clone https://github.com/LMQ00/dsh-method.git ~/Projects/dsh-method
dsh plugin --profile web add link:~/Projects/dsh-method
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

「可观察」的判定标准是结构化的，覆盖技术与非技术两类：

| 类型 | 例子 |
| --- | --- |
| 命令 / 退出码 | `` `pnpm test` 退出码为 0 `` |
| 文件 / 产物 | `docs/plan.md 存在`、`report/q3.docx 不少于 20 页` |
| 数值 / 阈值 | `测试覆盖率 ≥ 80%`、`输出 42 行` |
| 对比 / 状态值 | `accepted 为 true`、`返回码为 0` |
| 他人确认 / 交付物 | `收到订票确认邮件`、`合同已签署`、`客户在验收单上签字` |
| 状态达成 | `页面能打开`、`样机通过跌落测试` |

`确认一切正常`、`` `好` ``、`go`、`make it happen`、`随便看看`、`「完成」` 这类只有形容词和程度副词、既不指向对象也不指向状态的空话会被拒绝。

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
| `selftest.mjs` | 68 项自测，全部执行真实代码 |

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

68 项，覆盖：合法计划接受、结构缺陷拒绝、依赖图缺陷拒绝、验证覆盖缺陷拒绝、元信息缺陷拒绝、边界（超长/`null`/非对象）、判定可观察性的双向误报与漏报、投影折叠（含并发、乱序、状态必须是无损 JSON）、错误路径可诊断、渲染。

## 已知取舍

- **判定靠词表，识别不了的说法会被误拒**：`酒店订好了`、`机票已出票`、`行程已排好` 这类中文口语完成态既不命中产物名词、也不命中状态词，会被拒绝；而同义的 `已完成酒店预订`、`订单已生成` 会通过。同一个意思因为措辞不同而结果不同，这是当前实现的缺陷。[待改] 方向是反过来只检测空话（黑名单），而不是枚举所有合法说法（白名单）。
- **`.method/` 落在项目根下**：首次落盘时会在 `.method/` 内自写一个内容为 `*` 的 `.gitignore`，让它整目录不进版本控制，不改你的根 `.gitignore`。
- **同一项目多会话共用一份计划**：路径按工作目录定位，不含 session id，两个并行会话会写同一个 `plan.md`。
- **没有强制中断**：`plan_submit` 只在 method mode 下可用，但插件不阻止模型不调它就直接干活。真正要强制，得靠 `tools.guard` 拦截写操作——那是另一个量级的设计，当前版本刻意不做，避免变成「不开 method 就不能干活」。
