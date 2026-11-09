// Self-test for @local/dsh-llm-repeat-guard.
// Run: node test/detect.test.mjs
// 设计原则：既证明「退化会被中断」，也证明「正常文本不会被误杀」，
// 并用变异（把阈值调爆）证明这些断言真的在测守卫逻辑，而不是恒真。
import {
  DEFAULTS,
  detectRun,
  degenerateFinish,
  guardStream,
  isTrivialUnit,
  normalizeConfig,
} from '../index.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; failures.push(name); console.log('  FAIL', name, detail ?? '') }
}

const cfg = normalizeConfig({})

// ── 1. 真实退化样本 ───────────────────────────────────────────────
console.log('\n[1] degenerate samples (must trip)')
const realDegenerate = '**注意**：所有层的 bbox 都是 1280x1280（全画布）。\n\n**必须算内容 bbox**（从 alpha 通道）。\n\n做。\n重算。\n做。\n用 alpha 的非零区域算 bbox。\n\n'
  + '做。\n'.repeat(300)
ok('repetition of 做。trips', detectRun(realDegenerate, cfg) !== null, JSON.stringify(detectRun(realDegenerate, cfg)))

const englishDegenerate = 'I need to check the file. ' + 'wait.'.repeat(400)
ok('english repetition trips', detectRun(englishDegenerate, cfg) !== null)

const spacedEnglish = 'let me look. ' + 'wait. '.repeat(400)
ok('repetition with a trailing space trips', detectRun(spacedEnglish, cfg) !== null)

const copyOfDash = 'foo\n' + '----'.repeat(10) + '\n' + '#### '.repeat(40) + 'bar'
ok('repeated separators alone do not trip', detectRun(copyOfDash, cfg) === null)

// ── 2. 正常文本不许误杀 ───────────────────────────────────────────
console.log('\n[2] normal text (must NOT trip)')
const normalZh = '这个问题我先从三个角度看：一是请求体大小，二是模型自身的退化阈值，三是压缩策略。'
  + '测下来 46 万 token 开始轻微复读，54 万时爆炸。所以把窗口压到 40 万是合理的。'
ok('normal chinese prose', detectRun(normalZh, cfg) === null)

const markdownTable = [
  '| 项 | 值 |', '|---|---|', '| a | 1 |', '| b | 2 |', '| c | 3 |',
].join('\n')
ok('markdown table', detectRun(markdownTable, cfg) === null)

const divider = '-'.repeat(600)
ok('600 dashes (divider)', detectRun(divider, cfg) === null)
ok('isTrivialUnit("-")', isTrivialUnit('-') === true)
ok('isTrivialUnit("|")', isTrivialUnit('|') === true)
ok('isTrivialUnit("做") false', isTrivialUnit('做') === false)

const codeIndent = Array.from({ length: 40 }, (_, i) => `    const v${i} = f(${i})`).join('\n')
ok('indented code block', detectRun(codeIndent, cfg) === null)

const mixedZh = '好的。'.repeat(30)   // 30 次「好的。」——低于 120，不该判
ok('30 repeats stay under threshold', detectRun(mixedZh, cfg) === null)

// ── 3. 单字符单元门槛更高 ─────────────────────────────────────────
console.log('\n[3] single-char unit threshold')
ok('哈 x300 below single-char threshold', detectRun('哈'.repeat(300), cfg) === null)
ok('哈 x500 trips', detectRun('哈'.repeat(500), cfg) !== null)
// 尾部一旦接上别的字符，末位单元就变了；这是检测器「只看尾部」的固有语义，
// 用测试固定住它，免得以后误以为漏检是 bug。
ok('哈 x500 + 。 falls back to unit 。/哈。 and does not trip', detectRun('哈'.repeat(500) + '。', cfg) === null)

// ── 4. guardStream 端到端 ────────────────────────────────────────
console.log('\n[4] guardStream end-to-end')

async function* feedChunks(pieces) {
  for (const p of pieces) {
    if (typeof p === 'string') yield { type: 'reasoning-delta', index: 0, text: p }
    else yield p
  }
}

const degenerateStream = feedChunks(['做。'.repeat(500), 'TAIL-SHOULD-NOT-APPEAR'])
const out = []
let hitCount = 0
for await (const c of guardStream(degenerateStream, cfg, () => { hitCount++ })) out.push(c)

const finisher = out.find(c => c.type === 'finish')
ok('emits finish chunk', Boolean(finisher))
ok('finish kind is error', finisher?.reason?.kind === 'error', JSON.stringify(finisher))
ok('finish code is DEGENERATE_REPETITION', finisher?.reason?.failure?.code === 'DEGENERATE_REPETITION')
ok('onHit fired once', hitCount === 1, String(hitCount))
ok('does NOT pass through the tail after tripping', !out.some(c => typeof c.text === 'string' && c.text.includes('TAIL-SHOULD-NOT-APPEAR')))
ok('finish is the last chunk', out[out.length - 1] === finisher)

// 正常流必须原样透传、且不注入 finish
const normalStream = feedChunks(['这是', '一段', '正常', '输出。'])
const normalOut = []
for await (const c of guardStream(normalStream, cfg)) normalOut.push(c)
ok('normal stream passes through untouched', normalOut.length === 4 && normalOut.every(c => c.type === 'reasoning-delta'))
ok('normal stream injects no finish', !normalOut.some(c => c.type === 'finish'))

// ── 5. 变异自检：把阈值调到不可能达到，守卫就该失效 ────────────────
console.log('\n[5] mutation check (proves the assertions above are not vacuous)')
const disabledCfg = normalizeConfig({ minRepeats: 100000, singleCharMinRepeats: 100000 })
ok('huge threshold stops detectRun from tripping', detectRun(realDegenerate, disabledCfg) === null)
const mutatedOut = []
for await (const c of guardStream(feedChunks(['做。'.repeat(500)]), disabledCfg)) mutatedOut.push(c)
ok('huge threshold lets the degenerate stream through', !mutatedOut.some(c => c.type === 'finish'))

// ── 6. finish 块形态与 dsh-llm 一致 ───────────────────────────────
console.log('\n[6] finish chunk shape')
const sample = degenerateFinish({ unit: '做。', count: 19209, unitLength: 2 }, 'reasoning')
ok('has type finish', sample.type === 'finish')
ok('has reason.kind', typeof sample.reason?.kind === 'string')
ok('has reason.failure.message', typeof sample.reason?.failure?.message === 'string')
ok('message mentions the unit', sample.reason.failure.message.includes('做。'))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  pass=${pass} fail=${fail}`)
if (fail > 0) { console.log('failed:', failures.join(', ')); process.exit(1) }
