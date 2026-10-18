import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_AGENT_MODEL, RunpodPlanner } from '../llm/runpod.js'
import type { AgentMessage } from '../trends/planner.js'

const endpoint = 'test-endpoint'
const jobId = 'test-job-u1'
const tool = { name: 'wardrobe_search', description: 'Search wardrobe', parameters: { type: 'object', properties: {}, additionalProperties: false } }
const output = {
  model: DEFAULT_AGENT_MODEL, usage: { prompt_tokens: 120, completion_tokens: 12 },
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: tool.name, arguments: '{}' } }] } }],
}
const signal = () => new AbortController().signal

void test('Runpod LLM submits one OpenAI job, polls the same id and preserves tool correlation and usage', async () => {
  const requests: string[] = []
  const messages: AgentMessage[] = [
    { role: 'user', content: 'Find my tops' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'previous-call', function: { name: tool.name, arguments: { category: 'tops' } } }] },
    { role: 'tool', tool_call_id: 'previous-call', tool_name: tool.name, content: '{"items":[]}' },
  ]
  const planner = new RunpodPlanner(endpoint, 'private-key', undefined, async (url, options) => {
    requests.push(String(url))
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer private-key')
    assert.equal(options?.redirect, 'error')
    if (String(url).endsWith('/run')) {
      const body = JSON.parse(options?.body as string)
      assert.equal(body.input.openai_route, '/v1/chat/completions')
      assert.equal(body.input.openai_input.model, DEFAULT_AGENT_MODEL)
      assert.equal(body.input.openai_input.messages[1].tool_calls[0].function.arguments, '{"category":"tops"}')
      assert.deepEqual(body.input.openai_input.messages[2], { role: 'tool', tool_call_id: 'previous-call', content: '{"items":[]}' })
      assert.equal(body.input.openai_input.parallel_tool_calls, false)
      assert.equal(body.input.openai_input.max_tokens, 1200)
      assert.equal(body.policy.executionTimeout, 90000)
      return Response.json({ id: jobId, status: 'IN_QUEUE' })
    }
    return Response.json({ id: jobId, status: 'COMPLETED', output: [output] })
  })
  const result = await planner.next(messages, [tool], signal())
  assert.deepEqual(result.calls, [{ id: 'call-1', name: tool.name, arguments: '{}' }])
  assert.deepEqual(result.usage, { promptTokens: 120, completionTokens: 12, costUsd: null })
  assert.equal(result.model, DEFAULT_AGENT_MODEL)
  assert.deepEqual(requests, [`https://api.runpod.ai/v2/${endpoint}/run`, `https://api.runpod.ai/v2/${endpoint}/status/${jobId}`])
})

void test('Runpod LLM forces final tools and supports plain Russian answers', async () => {
  const planner = new RunpodPlanner(endpoint, 'secret', undefined, async (_url, options) => {
    const body = JSON.parse(options?.body as string).input.openai_input
    if (body.tools) assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'wardrobe_finish' } })
    else assert.equal('tool_choice' in body, false)
    return Response.json({ id: jobId, status: 'COMPLETED', output: { choices: [{ finish_reason: 'stop', message: { content: 'Здравствуйте! Помогу собрать образ.' } }] } })
  })
  const final = { ...tool, name: 'wardrobe_finish' }
  assert.equal((await planner.next([], [final], signal())).content, 'Здравствуйте! Помогу собрать образ.')
  assert.deepEqual((await planner.next([], [], signal())).calls, [])
})

void test('cancellation during submission receives the id and cancels that job without a repeat', async () => {
  const controller = new AbortController()
  const paths: string[] = []
  const planner = new RunpodPlanner(endpoint, 'secret', undefined, async url => {
    paths.push(String(url))
    controller.abort()
    return Response.json({ id: jobId, status: String(url).endsWith('/run') ? 'IN_QUEUE' : 'CANCELLED' })
  })
  await assert.rejects(planner.next([], [tool], controller.signal))
  assert.deepEqual(paths, [`https://api.runpod.ai/v2/${endpoint}/run`, `https://api.runpod.ai/v2/${endpoint}/cancel/${jobId}`])
})

void test('provider errors and malformed or truncated results never cause paid retries or leak secrets', async () => {
  for (const response of [
    () => new Response('private-key and provider trace', { status: 401 }),
    () => Response.json({ id: jobId, status: 'FAILED', error: 'private-key and provider trace' }),
    () => Response.json({ id: jobId, status: 'COMPLETED', output: { error: { message: 'private-key and provider trace' } } }),
    () => Response.json({ id: jobId, status: 'COMPLETED', output: { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] } }),
  ]) {
    let calls = 0
    const planner = new RunpodPlanner(endpoint, 'private-key', undefined, async () => { calls++; return response() })
    await assert.rejects(planner.next([], [tool], signal()), (error: unknown) => error instanceof Error && !error.message.includes('private-key') && !error.message.includes('provider trace'))
    assert.equal(calls, 1)
  }
})

void test('invalid endpoint and pre-aborted requests never contact Runpod', async () => {
  assert.throws(() => new RunpodPlanner('../external-host', 'key'))
  assert.throws(() => new RunpodPlanner(endpoint, ''))
  let calls = 0
  const planner = new RunpodPlanner(endpoint, 'secret', undefined, async () => { calls++; return Response.json({}) })
  await assert.rejects(planner.next([], [], AbortSignal.abort()))
  assert.equal(calls, 0)
})
