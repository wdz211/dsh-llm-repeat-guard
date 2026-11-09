/**
 * @local/dsh-llm-repeat-guard
 *
 * 退化复读守卫（degenerate repetition guard）。
 *
 * 背景（2026-10-20 实测）：deepseek-v4.1-flash 在 ~46 万 token 的请求上会开始
 * 轻微复读，54.6 万 token 时彻底坍缩——一次 step 输出 3.9 万 token 全是「做。」，
 * 连续 19209 次，用户只能干等十几分钟再手动中断。这不是 DSH 的 bug，是解码在
 * 高不确定性处的吸引子坍缩（Holtzman et al. 2019 的 neural text degeneration）。
 *
 * 我们能做的是止损：拦住 `llm/stream`，一旦发现机械重复超过阈值，立刻发一个
 * 终止块结束这次调用，而不是让模型继续烧 token。用户看到的是「模型输出退化，
 * 已中断」，而不是「一直在思考」。
 *
 * 通道：`llm/stream` waterfall
 *   'llm/stream'(this: LlmRuntime, options: GenerateOptions, next) => AsyncIterable<StreamChunk>
 * 实现见 dsh-llm/lib/index.js:2370 的 streamWithRegistration → ctx.waterfall。
 *
 * 形态纪律（踩过的坑）：
 *   · 只用具名导出 name/inject/apply，**不写 export default**（Loader 的
 *     unwrapExports 会把 default 当插件本体，name/inject 全丢）。
 *   · 不改写 options（LOOP 请求是 deep-frozen，改就抛）。
 */

export const name = 'llm-repeat-guard'

/** 只依赖 llm；webServer 不声明——守卫不需要 HTTP 面，少一个激活前提。 */
export const inject = ['llm']

export const DEFAULTS = {
  enabled: true,
  /** 非单字符单元（短语）连续重复达到多少次判为退化 */
  minRepeats: 120,
  /**
   * 单字符单元的阈值。单字符更容易在正常文本里偶然重复（列表符号、省略号），
   * 所以门槛抬高；同时 ASCII 标点/空白一律跳过（见 isTrivialUnit），
   * 避免把 `-----` 分隔线、表格 `||||` 误判成退化。
   */
  singleCharMinRepeats: 400,
  /**
   * 参与检测的单元最大长度（字符）。
   * 8 而不是 4：真实退化单元常常带空白/换行，`wait. ` 是 6 个字符，
   * `做。\n\n` 是 4 个。太小的 unitMax 会让这类整段重复从缝里漏过去。
   */
  unitMax: 8,
  /** 累计输出超过这么多字符才开始判（防止一开始就误判） */
  minChars: 600,
  /** 每种块保留的尾部窗口 */
  windowChars: 2000,
  /** 每新增这么多字符才做一次检测（节流） */
  checkEveryChars: 24,
}

const TRIVIAL_ASCII = new Set([
  '-', '=', '*', '_', '|', '#', '.', ',', ';', ':', '~', '+', '/', '\\',
  '<', '>', ' ', '\t', '\n', '\r',
])

/**
 * 这个单元是否属于「正常文本里也会长成这样」的纯排版字符。
 *
 * 必须是**整段**都由排版字符组成才算 trivial —— 只挡单字符是不够的：
 * `'-'.repeat(600)` 在 n=2 时的单元是 `--`，如果只在 n===1 时挡，
 * 300 次 `--` 就会被判成退化（实测踩过，测试红在 600 dashes 那条）。
 * 反过来 `做。` 含非排版字符，不会被这条误挡。
 */
export function isTrivialUnit(unit) {
  if (unit.length === 0) return true
  for (const ch of unit) if (!TRIVIAL_ASCII.has(ch)) return false
  return true
}

export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d)
  return {
    enabled: c.enabled !== false,
    minRepeats: num(c.minRepeats, DEFAULTS.minRepeats),
    singleCharMinRepeats: num(c.singleCharMinRepeats, DEFAULTS.singleCharMinRepeats),
    unitMax: Math.min(num(c.unitMax, DEFAULTS.unitMax), 8),
    minChars: num(c.minChars, DEFAULTS.minChars),
    windowChars: Math.max(num(c.windowChars, DEFAULTS.windowChars), 200),
    checkEveryChars: num(c.checkEveryChars, DEFAULTS.checkEveryChars),
  }
}

/**
 * 检测 tail 末尾是否出现「同一个短单元连续重复」。
 *
 * 从尾部往前数：unit 长度的候选依次试 1..unitMax，取能连续匹配最多的那个。
 * 不回溯、不做全文扫描——只在尾部窗口里做，单次代价 O(windowChars * unitMax)。
 *
 * 返回 null 或 { unit, count, unitLength }。
 */
export function detectRun(tail, cfg = DEFAULTS) {
  if (typeof tail !== 'string' || tail.length === 0) return null
  const unitMax = Math.min(cfg.unitMax ?? DEFAULTS.unitMax, Math.max(1, Math.floor(tail.length / 2)))

  for (let n = 1; n <= unitMax; n++) {
    const unit = tail.slice(tail.length - n)
    /**
     * 阈值按单元「性质」选，不按单元长度选。
     *
     * 一开始只在 n===1 时用高门槛，结果 `'哈'.repeat(300)` 在 n=2 时被单元
     * `哈哈` 以 120 的门槛判死（测试抓到的）。同一个退化模式换个切法就绕过守卫，
     * 等于守卫形同虚设。所以判据是「这段文字是不是同一个字符反复写」，
     * 而不是「它有多长」。
     */
    const allSameChar = [...unit].every((ch) => ch === unit[0])
    const threshold = allSameChar
      ? (cfg.singleCharMinRepeats ?? DEFAULTS.singleCharMinRepeats)
      : (cfg.minRepeats ?? DEFAULTS.minRepeats)
    if (tail.length < n * threshold) continue

    if (isTrivialUnit(unit)) continue          // `-----` / `||||` 这类不判
    if (unit.trim().length === 0) continue     // 纯空白不判

    let count = 1
    let pos = tail.length - n
    while (pos - n >= 0) {
      if (tail.slice(pos - n, pos) !== unit) break
      count++
      if (count >= threshold) return { unit, count, unitLength: n }
      pos -= n
    }
  }
  return null
}

/** 造终止块：与 dsh-llm 自己的 adapterFailureChunk 同形。 */
export function degenerateFinish(hit, kind) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `Model output degenerated into repetition (${kind}: ${JSON.stringify(hit.unit)} repeated ${hit.count}x). `
          + 'Stream aborted by llm-repeat-guard so the turn does not keep burning tokens.',
        code: 'DEGENERATE_REPETITION',
      },
    },
  }
}

/**
 * 包装一条 chunk 流。导出是为了能脱离 Cordis 单测（用假流喂数据）。
 */
export async function* guardStream(upstream, cfg, onHit) {
  const tails = { reasoning: '', text: '' }
  let total = 0
  let sinceCheck = 0

  for await (const chunk of upstream) {
    const type = chunk && chunk.type
    if (type === 'reasoning-delta' || type === 'text-delta') {
      const kind = type === 'reasoning-delta' ? 'reasoning' : 'text'
      const add = typeof chunk.text === 'string' ? chunk.text : ''
      if (add.length > 0) {
        let t = tails[kind] + add
        if (t.length > cfg.windowChars) t = t.slice(-cfg.windowChars)
        tails[kind] = t
        total += add.length
        sinceCheck += add.length

        if (total >= cfg.minChars && sinceCheck >= cfg.checkEveryChars) {
          sinceCheck = 0
          const hit = detectRun(t, cfg)
          if (hit) {
            if (onHit) onHit(hit, kind)
            yield degenerateFinish(hit, kind)
            return
          }
        }
      }
    }
    yield chunk
  }
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  const log = (level, ...args) => {
    const line = `[llm-repeat-guard] ${args.join(' ')}`
    try {
      if (level === 'warn' && ctx.logger?.warn) ctx.logger.warn(line)
      else if (ctx.logger?.info) ctx.logger.info(line)
      else console.log(line)
    } catch {
      console.log(line)
    }
  }

  if (!cfg.enabled) {
    log('info', 'disabled by config; not attaching')
    return
  }

  // 启动期取服务只能用 ctx.get(name, false)（属性访问在 inactive 上下文会抛）。
  const llm = ctx.get('llm', false)
  if (!llm) {
    log('warn', 'llm service unavailable at apply time; guard NOT attached')
    return
  }

  let tripped = 0

  ctx.on('llm/stream', (options, next) => {
    const upstream = next()
    const purpose = options?.purpose ? ` purpose=${options.purpose}` : ''
    return guardStream(upstream, cfg, (hit, kind) => {
      tripped++
      log(
        'warn',
        `DEGENERATE_REPETITION in ${kind}${purpose}: unit ${JSON.stringify(hit.unit)} x${hit.count} `
        + `(provider=${options?.provider ?? '?'} model=${options?.model ?? '?'}); stream aborted. total tripped=${tripped}`,
      )
    })
  })

  log(
    'info',
    `attached to llm/stream (minRepeats=${cfg.minRepeats}, singleCharMinRepeats=${cfg.singleCharMinRepeats}, `
    + `unitMax=${cfg.unitMax}, windowChars=${cfg.windowChars})`,
  )
}
