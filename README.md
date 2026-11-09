# dsh-llm-repeat-guard

> Abort a streaming LLM call the moment its reasoning or text collapses into mechanical repetition — stop the bleeding instead of burning the whole turn.

## 这是什么

DeepSeek Harness Desktop 的一个宿主侧插件。它挂在 `llm/stream` 这条 waterfall 上，逐块看模型正在吐的内容；一旦发现输出退化成「同一个短单元连续重复」，立刻给这一轮补一个终止块结束调用。

为什么需要它（2026-10-20 实测）：一次约 46 万 token 的请求上，`deepseek-v4.1-flash` 开始轻微复读；到 54.6 万 token 时彻底坍缩——一个 step 输出了 3.9 万 token 全是「做。」，连续 19209 次。在它发生的那十几分钟里，界面上只有「模型还在思考」，除了手动点中断没有别的办法，而那一轮的 token 已经全烧掉了。

这不是 DSH 的 bug，是解码在高不确定性处的吸引子坍缩（neural text degeneration, Holtzman et al. 2019）。模型侧不可控，宿主侧能做的只有止损：**发现退化就把这一轮截断**，把「一直在思考」变成一句明确的「模型输出退化，已中断」。

给谁用：跑长上下文、长 reasoning 的会话；尤其是无人值守的自动化——那时没人会去点中断，一轮烧到底的代价全是白付的。

定位：极小、零依赖、纯旁路。不注册工具，不改 prompt，不碰模型参数，只在流上做一次廉价的尾部模式检测。

## 前置条件

**诚实地写**：这不是一个能 `npm i` 完就用的独立库，它是 DeepSeek Harness Desktop 的插件。它需要 DSH 宿主提供的 Cordis 运行时（`ctx`、`ctx.on`、waterfall 语义），并且需要宿主的 `llm` 服务在装配时可用。没有宿主，`index.js` 只能被 import，什么也不会发生。

`detectRun` / `isTrivialUnit` / `normalizeConfig` / `guardStream` / `degenerateFinish` 都是无副作用的纯函数或纯生成器，可以在 Node 里单独拿来用（测试就是这么做的）。

## 安装

1. 把仓库目录放进 profile 的 `node_modules`（junction / symlink 都行，DSH 的 Loader 走真实路径读）：

```
<mktemp>/node_modules/dsh-llm-repeat-guard  ->  <checkout>/dsh-llm-repeat-guard
```

2. 在 profile 的 `cordis.patch.yml` 里加一条 insert，把它挂成 bundle 的一部分：

```yaml
- insert:
    - id: llm-repeat-guard
      name: 'dsh-llm-repeat-guard'
      config:
        enabled: true
        minRepeats: 120
        singleCharMinRepeats: 400
        unitMax: 8
        minChars: 600
        windowChars: 2000
```

本仓库自带一份可参考的 `cordis.patch.yml`，就是上面这段（带当时的实测注释）。

3. 整套 App 重启。`cordis.patch.yml` 是 load-once 的，热重载不会重新读它。

4. 验证挂上了：宿主日志里应出现一行
`[llm-repeat-guard] attached to llm/stream (minRepeats=120, singleCharMinRepeats=400, unitMax=8, windowChars=2000)`。
没有这行就是没挂上——最常见的原因是装配时 `llm` 服务还不可见，那时它只打一条
`llm service unavailable at apply time; guard NOT attached` 并让位，不会抛错。

## 配置

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | boolean | `true` | 为 `false` 时完全不挂 waterfall，apply 直接返回 |
| `minRepeats` | number | `120` | 非单字符单元（短语）连续重复到多少次判为退化 |
| `singleCharMinRepeats` | number | `400` | 单元全是同一个字符（「啊」「哈」）时的门槛，特意抬高 |
| `unitMax` | number | `8`（硬上限 8） | 参与检测的单元最大长度（字符） |
| `minChars` | number | `600` | 累计输出超过这么多字符才开始判，避免开头误判 |
| `windowChars` | number | `2000`（下限 200） | 每个通道（reasoning / text）各自保留的尾部窗口 |
| `checkEveryChars` | number | `24` | 每新增这么多字符才检测一次（节流） |

阈值是校准出来的，不是拍的：实测退化时的重复量在 680 ~ 52216 次之间，而正常文本里偶然的重复峰值只有 30 ~ 80 次——120 落在两者中间；单字符单元（列表符号、「哈哈」这类语气词）更容易偶发，所以抬到 400。`unitMax` 取 8 而不是 4，是因为真实的退化单元常带空白/换行（`wait. ` 是 6 个字符、`做。\n\n` 是 4 个），切得太短会让整段重复从缝里漏过去。把这套配置在 10445 个真实 reasoning 块上跑过：触发 37 次，全部落在 3 个已知的退化会话里，正常块零误报。

## 判据是什么

检测只做一件事：看尾部窗口里，有没有「同一个单元反复出现」。

- 单元长度从 1 试到 `unitMax`，取能连续匹配最多次的那个候选；
- **阈值按单元的性质选，不按长度选**：单元里所有字符都相同时用 `singleCharMinRepeats`，否则用 `minRepeats`。这一条是被测试逼出来的——早期只在 `n === 1` 时抬高门槛，结果 `'哈'.repeat(300)` 在 `n = 2` 时被单元「哈哈」以 120 的门槛判死；同一个退化模式换个切法就能绕过守卫，等于守卫形同虚设；
- **纯排版字符不判**：整段都由 `-=*_|#.,;:~+/\<>` 和空白组成的单元直接跳过，`'-'.repeat(600)`、Markdown 表格的 `||||` 不会被误杀。注意是「整段都脏」才算，`做。` 含非排版字符，照旧会判；
- 只看尾部：不回溯、不扫全文，单次代价约 `windowChars × unitMax`，在 24 字符的节流下对吞吐没有可见影响。

## 命中之后：截断，不是 throw

命中时它**不抛异常**。它向下游 yield 一个 `finish` 块，然后 `return` —— 上游生成器随之不再被消费：

```js
{ type: 'finish', reason: { kind: 'error', failure: {
    message: 'Model output degenerated into repetition (reasoning: "做。" repeated 19209x). ...',
    code: 'DEGENERATE_REPETITION' } } }
```

这个形状是照着 `dsh-llm` 自己的 adapterFailureChunk 抄的，所以上层把它当成一次普通的调用失败处理：这一轮结束、错误可见、会话可继续。

为什么不是直接 throw：上游是宿主已经包好的流式适配器，它会把适配器失败**转成 finish 分片**（这条链路里 catch 分支基本是死代码）；自己先给一个形态正确的 finish 块，等于把「怎么结束」这件事留在确定的地方，而不是赌某层的异常处理。

## 对外能力

本插件**不注册任何工具**，对模型不可见。它对宿主只做两件事：订阅 `llm/stream` waterfall；命中时打一条 `warn` 日志。对使用者（或二次开发）暴露的是几个纯函数：

| 导出 | 类型 | 行为 |
|---|---|---|
| `detectRun(tail, cfg)` | `(string, cfg) => {unit, count, unitLength} \| null` | 判断一段尾部文本是否已退化成机械重复 |
| `isTrivialUnit(unit)` | `(string) => boolean` | 该单元是否全由排版字符构成（是则不判） |
| `normalizeConfig(raw)` | `(object) => cfg` | 补齐默认值、夹紧上下限（`unitMax ≤ 8`、`windowChars ≥ 200`） |
| `guardStream(upstream, cfg, onHit)` | `AsyncGenerator` | 包装任意 chunk 流；命中时注入 finish 并停止消费上游 |
| `degenerateFinish(hit, kind)` | `(hit, 'reasoning'\|'text') => StreamChunk` | 造终止块 |
| `DEFAULTS` | `object` | 默认阈值 |

## 已知限制

- **它止不住退化，只能止损。** 已经吐出来的 token 追不回来；命中之后这一轮是以错误结束的，不会自动重试。
- **只看尾部窗口。** 周期长于 `unitMax`（默认 8 字符）的重复模式抓不到；这是刻意换来的：窗口越大、回溯越多，代价越高，而真实的退化几乎都是 1~8 字符的小单元。
- **只看「当前末尾正好是一个重复单元」。** 如果最后一个字符变化了，末位单元就跟着变，可能漏检。这是检测器的固有语义，测试里专门锁了这条（`'哈'.repeat(500) + '。'` 不触发），免得以后把它当 bug 改。
- **两个通道分别计数。** reasoning 与 text 各有自己的尾部窗口，交替输出不会互相抵消、也不合并统计。
- **排版字符的退化是已知的假阴性。** 如果模型坍缩成 `-----` 或 `||||`，本插件故意不判——为了不误杀分隔线与表格，代价交给别的手段。
- **装配时 `llm` 不可见就整体让位。** 只打 `warn`，不抛错、不重试；那种情况下必须重启，等 `llm` 就位。
- **不改 `options`。** LOOP 请求的 options 是 deep-frozen，任何改写都会抛；插件只读 `purpose`/`provider`/`model` 用于日志。

## 开发

```bash
node --test          # 29 条断言，全部离线可跑，不碰宿主
node test/detect.test.mjs   # 也可以直接当脚本跑，看逐条 PASS/FAIL
```

自测分六组：真实退化样本必须触发；正常文本（散文、表格、缩进代码、分隔线、30 次以内的重复）必须不触发；单字符门槛；`guardStream` 端到端（含「命中后不再透传后续块」）；**变异自检**（把阈值调到不可能达到，守卫必须失效——证明前面的断言不是恒真的）；finish 块形状。

结构：

```
index.js              全部逻辑（1 个入口，无依赖，无子模块）
test/detect.test.mjs  纯函数 + guardStream 的自测
cordis.patch.yml   挂载声明与实测阈值注释
```

## 许可

MIT，见 [LICENSE](LICENSE)。无上游代码。
