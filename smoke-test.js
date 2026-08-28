'use strict'
/**
 * 独立冒烟测试：不依赖 dsh 宿主，直接驱动 CodeBuddyAdapter.stream()。
 * 用法：node smoke-test.js [modelId]
 * 会真实调用上游（极小 token 量），需要本机已有 CodeBuddy 登录会话。
 */
const plugin = require('./lib/index.js')

const MODEL = process.argv[2] || 'hy3'

;(async () => {
  console.log('session file:', plugin.authFilePath())
  const s = plugin.loadSessionFile()
  console.log('session loaded:', !!s, '| domain:', s?.domain, '| expiresAt:', s ? new Date(s.expiresAt).toISOString() : '-')

  const ctx = { logger: { info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[err]', m) } }
  const adapter = new plugin.CodeBuddyAdapter(ctx)

  const models = await adapter.listModels()
  console.log('models:', models.length, models.map((m) => m.id).join(','))

  const prep = await adapter.prepareCall('codebuddy', MODEL)
  const events = []
  let text = ''
  const stream = prep.stream({
    model: MODEL,
    system: 'You are a concise assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly two words: hello world' }] }],
    maxTokens: 64,
    reasoningEffort: 'off',
    tools: [],
  })
  for await (const ev of stream) {
    events.push(ev.type)
    if (ev.type === 'text-delta') text += ev.text
    if (ev.type === 'usage') console.log('usage:', JSON.stringify(ev.usage))
    if (ev.type === 'finish') console.log('finish:', JSON.stringify(ev.reason))
  }
  console.log('event types:', [...new Set(events)].join(','))
  console.log('final text:', JSON.stringify(text))
  console.log('SMOKE', text.trim() ? 'PASS' : 'FAIL')
})().catch((e) => { console.error('SMOKE FAIL:', e.code || '', e.message); process.exit(1) })
