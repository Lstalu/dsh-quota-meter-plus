// 子代理/多 agent 归属回归测试（直接驱动 index.js 的真实事件面）
//
// 复现的缺陷：多 agent（AgentTeams）成员会话的消耗没有并入发起会话的账本，
// 而是留在成员自己的账本里 —— 会话 UI 上显示的金額只有"队长"自己的那一份；
// 成员会话被销毁时账本文件还会被删除，那部分消耗直接从账本里消失。
//
// 归属信号必须是会话 header（parentSession + origin:'subagent'）：
// subagent/start 的回调只收到 info —— parent 被 createLifecycleEmitter 当作
// scoped dispatch 的 carrier 用掉了（callback(info)），所以第二个参数永远是
// undefined，不能作为归属依据。
//
// 运行：node test/subagent-attribution.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(pathToFileURL(join(here, '..', 'index.js')).href)

let failures = 0
// 用 process.stdout 直写：quiet() 会把 console.log 静音，断言输出必须绕开它
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}\n`)
}

// 每个用例一个临时 DSH home（账本落盘路径由 dshHomePath 决定）
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'quota-attrib-'))
  mkdirSync(join(home, 'storages', 'quota-meter', 'sessions'), { recursive: true })
  return home
}

const ledgerPath = (home, id) => join(home, 'storages', 'quota-meter', 'sessions', id + '.json')
const readLedger = (home, id) => {
  const p = ledgerPath(home, id)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const writeLedger = (home, id, data) => writeFileSync(ledgerPath(home, id), JSON.stringify(data))
const spentOf = (home, id) => { const l = readLedger(home, id); return l === null ? null : l.spent }
const callsOf = (home, id) => { const l = readLedger(home, id); return l === null ? null : l.calls }

// 真实事件面：ctx.on / ctx.dshHomePath / ctx.webServer.register / ctx.apiProxy
function makeCtx(home) {
  const handlers = new Map()
  return {
    handlers,
    on(name, fn, _opts) { handlers.set(name, fn) },
    dshHomePath(...segs) { return join(home, ...segs) },
    webServer: { register() {} },
    apiProxy: {
      sessions: {
        async models() {
          return { result: { ok: true, value: { current: { model: 'deepseek-v4-flash' }, groups: [] } } }
        },
      },
    },
  }
}

// 消费一次 llm/stream 包装流（usage chunk 是记账的唯一入口）
async function runCall(ctx, { sessionId, model, usage, purpose }) {
  const handler = ctx.handlers.get('llm/stream')
  if (!handler) throw new Error('llm/stream handler not registered')
  const stream = handler({ sessionId, model, purpose }, async function* () {
    yield { type: 'text', text: 'ignored' }
    yield { type: 'usage', usage }
  })
  for await (const _chunk of stream) { /* drain */ }
}

// 驱动 agent/pre-step（agent loop 对每个 agent 的每一步派发，早于该步的模型调用）
async function preStep(ctx, agent) {
  const handler = ctx.handlers.get('agent/pre-step')
  if (!handler) throw new Error('agent/pre-step handler not registered')
  return handler({ agent, messages: [], turn: 1, step: 1, signal: undefined }, async () => 'next')
}

// 子会话的 Agent：session.header 就是持久化的 SessionHeader
const agentOf = (sessionId, { parentSession, origin, delegationDepth } = {}) => ({
  session: {
    id: sessionId,
    header: {
      version: 0,
      id: sessionId,
      createdAt: Date.now(),
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(origin === undefined ? {} : { origin }),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    },
  },
})
const childAgent = (id, parent) => agentOf(id, { parentSession: parent, origin: 'subagent', delegationDepth: 1 })

const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 }

// 静音插件的 console.log 记账流水，保留断言输出
const realLog = console.log
const quiet = async (fn) => { console.log = () => {}; try { return await fn() } finally { console.log = realLog } }

const ROOT = 'session-d4f9178a-99b8-4924-8c23-569da4b534bf'

// ── Case 1：AgentTeams 成员（uuid 形子会话）的消耗必须并入发起会话 ──────────
{
  const home = makeHome()
  const ctx = makeCtx(home)
  apply(ctx)
  const member = '6c4bdda1-f58a-4621-90de-cf5870172dc3'

  await quiet(async () => {
    await runCall(ctx, { sessionId: ROOT, model: 'deepseek-v4-flash', usage: USAGE })
    const ownOnly = spentOf(home, ROOT)
    await preStep(ctx, childAgent(member, ROOT)) // 成员开工（第一步之前）
    await runCall(ctx, { sessionId: member, model: 'deepseek-v4-flash', usage: USAGE })
    check('Case1 成员消耗计入发起会话（root 翻倍）', spentOf(home, ROOT), ownOnly * 2)
    check('Case1 成员调用计入发起会话 calls', callsOf(home, ROOT), 2)
    check('Case1 成员账本金额为 0（不重复持有）', spentOf(home, member), 0)
    check('Case1 成员账本落盘 parentId（重启后可恢复映射）', readLedger(home, member).parentId, ROOT)
  })
  rmSync(home, { recursive: true, force: true })
}

// ── Case 2：fork 会话带 parentSession 但不是子代理，不得并账 ────────────────
{
  const home = makeHome()
  const ctx = makeCtx(home)
  apply(ctx)
  const fork = 'session-77aa11bb-2222-3333-4444-555566667777'

  await quiet(async () => {
    await preStep(ctx, agentOf(fork, { parentSession: ROOT })) // 无 origin
    await runCall(ctx, { sessionId: fork, model: 'deepseek-v4-flash', usage: USAGE })
    check('Case2 fork 消耗留在自己账本', spentOf(home, fork) > 0, true)
    check('Case2 fork 不产生发起会话账本', readLedger(home, ROOT), null)
  })
  rmSync(home, { recursive: true, force: true })
}

// ── Case 3：成员会话此前已独立记下的消耗，在认领时补归发起会话 ─────────────
{
  const home = makeHome()
  const ctx = makeCtx(home)
  apply(ctx)
  const member = '96cfd7f8-ece1-4bf1-b4b6-94c836b22167'

  // 旧版本遗留在磁盘上的成员账本（真实值：¥10.0179 / 268 次）
  writeLedger(home, member, { quota: null, spent: 10.0179, calls: 268, unpricedModels: [] })

  await quiet(() => preStep(ctx, childAgent(member, ROOT)))

  check('Case3 遗留成员账本补归到发起会话', spentOf(home, ROOT), 10.0179)
  check('Case3 遗留成员账本 calls 补归', callsOf(home, ROOT), 268)
  check('Case3 遗留成员账本清零', spentOf(home, member), 0)
  rmSync(home, { recursive: true, force: true })
}

// ── Case 4：多层委派（成员的子代理）必须一路上溯到根会话 ──────────────────
{
  const home = makeHome()
  const ctx = makeCtx(home)
  apply(ctx)
  const member = '5aecbb66-37dd-4773-be26-768f1a1d28ce'
  const grandchild = '01c8c927-07b9-4933-b26a-b24b06c99018'

  await quiet(async () => {
    await preStep(ctx, childAgent(member, ROOT))
    await preStep(ctx, childAgent(grandchild, member))
    await runCall(ctx, { sessionId: grandchild, model: 'deepseek-v4-flash', usage: USAGE })
    check('Case4 孙代理消耗记在根会话', callsOf(home, ROOT), 1)
    check('Case4 根会话金额 > 0', spentOf(home, ROOT) > 0, true)
  })
  rmSync(home, { recursive: true, force: true })
}

// ── Case 5：同一成员重复 pre-step 不得重复并入 ─────────────────────────────
{
  const home = makeHome()
  const ctx = makeCtx(home)
  apply(ctx)
  const member = '5f3671f9-976f-494c-a813-115b23badc00'

  await quiet(async () => {
    await preStep(ctx, childAgent(member, ROOT))
    await runCall(ctx, { sessionId: member, model: 'deepseek-v4-flash', usage: USAGE })
    const afterFirst = spentOf(home, ROOT)
    await preStep(ctx, childAgent(member, ROOT))
    await preStep(ctx, childAgent(member, ROOT))
    check('Case5 重复认领不重复并入', spentOf(home, ROOT), afterFirst)
  })
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`)
process.exitCode = failures === 0 ? 0 : 1
