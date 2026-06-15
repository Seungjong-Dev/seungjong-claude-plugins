import { test, expect } from 'bun:test'
import { CeteTasksClient } from '../client'

const CFG = { url: 'http://127.0.0.1:8787', secret: 's3cret', agent: 'agent-a' }

/** A fetch double that records calls and replies with whatever `reply` returns. */
function fakeFetch(reply: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = []
  const fn = async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return reply(String(url), init)
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const TASK = {
  id: 't1', target: 'agent-a', title: 'do x', body: '', status: 'open', priority: 0,
  created_by: 'agent-a', result: null, error: null, nudged_at: null,
  created_at: '2026-06-15T00:00:00Z', updated_at: '2026-06-15T00:00:00Z',
}

test('assign_task POSTs /tasks with created_by=$AGENT and returns the task', async () => {
  const f = fakeFetch(() => json({ ok: true, task: { ...TASK, id: 'new' } }, 201))
  const c = new CeteTasksClient(CFG, f.fn)
  const task = await c.assignTask({ target: 'agent-b', title: 'do x', priority: 2 })

  expect(task.id).toBe('new')
  expect(f.calls).toHaveLength(1)
  const { url, init } = f.calls[0]
  expect(url).toBe('http://127.0.0.1:8787/tasks')
  expect(init.method).toBe('POST')
  expect(init.headers['X-Auth']).toBe('s3cret')
  expect(JSON.parse(init.body)).toEqual({ target: 'agent-b', title: 'do x', priority: 2, created_by: 'agent-a' })
})

test('assign_task omits undefined optional fields from the body', async () => {
  const f = fakeFetch(() => json({ ok: true, task: TASK }, 201))
  const c = new CeteTasksClient(CFG, f.fn)
  await c.assignTask({ target: 'agent-b', title: 'do x' })
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ target: 'agent-b', title: 'do x', created_by: 'agent-a' })
})

test('my_tasks GETs by target=$AGENT and filters to active (open+claimed) client-side by default', async () => {
  const tasks = [
    { ...TASK, id: 'o', status: 'open' },
    { ...TASK, id: 'c', status: 'claimed' },
    { ...TASK, id: 'd', status: 'done' },
    { ...TASK, id: 'x', status: 'cancelled' },
  ]
  const f = fakeFetch(() => json({ ok: true, tasks }))
  const c = new CeteTasksClient(CFG, f.fn)
  const out = await c.myTasks()

  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks?target=agent-a')
  expect(f.calls[0].init.method ?? 'GET').toBe('GET')
  expect(out.map(t => t.id).sort()).toEqual(['c', 'o'])
})

test('my_tasks passes an explicit status through as a query param and does not re-filter', async () => {
  const f = fakeFetch(() => json({ ok: true, tasks: [{ ...TASK, id: 'd', status: 'done' }] }))
  const c = new CeteTasksClient(CFG, f.fn)
  const out = await c.myTasks('done')
  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks?target=agent-a&status=done')
  expect(out.map(t => t.id)).toEqual(['d'])
})

test('claim_task POSTs /tasks/{id}/claim with actor=$AGENT', async () => {
  const f = fakeFetch(() => json({ ok: true, task: { ...TASK, status: 'claimed' } }))
  const c = new CeteTasksClient(CFG, f.fn)
  const task = await c.claimTask('t1')
  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks/t1/claim')
  expect(f.calls[0].init.method).toBe('POST')
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ actor: 'agent-a' })
  expect(task.status).toBe('claimed')
})

test('complete_task POSTs /tasks/{id}/complete with result + actor', async () => {
  const f = fakeFetch(() => json({ ok: true, task: { ...TASK, status: 'done', result: 'ok' } }))
  const c = new CeteTasksClient(CFG, f.fn)
  const task = await c.completeTask('t1', 'ok')
  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks/t1/complete')
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ result: 'ok', actor: 'agent-a' })
  expect(task.status).toBe('done')
})

test('fail_task POSTs /tasks/{id}/fail with error + actor', async () => {
  const f = fakeFetch(() => json({ ok: true, task: { ...TASK, status: 'failed', error: 'boom' } }))
  const c = new CeteTasksClient(CFG, f.fn)
  await c.failTask('t1', 'boom')
  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks/t1/fail')
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ error: 'boom', actor: 'agent-a' })
})

test('cancel_task POSTs /tasks/{id}/cancel with actor', async () => {
  const f = fakeFetch(() => json({ ok: true, task: { ...TASK, status: 'cancelled' } }))
  const c = new CeteTasksClient(CFG, f.fn)
  await c.cancelTask('t1')
  expect(f.calls[0].url).toBe('http://127.0.0.1:8787/tasks/t1/cancel')
  expect(JSON.parse(f.calls[0].init.body)).toEqual({ actor: 'agent-a' })
})

// --- error mapping ---

test('409 invalid transition → "cannot <verb>: <server error>"', async () => {
  const f = fakeFetch(() => json({ ok: false, error: 'task is already claimed' }, 409))
  const c = new CeteTasksClient(CFG, f.fn)
  await expect(c.claimTask('t1')).rejects.toThrow('cannot claim: task is already claimed')
})

test('404 → "task <id> not found"', async () => {
  const f = fakeFetch(() => json({ ok: false, error: 'no such task' }, 404))
  const c = new CeteTasksClient(CFG, f.fn)
  await expect(c.completeTask('ghost', 'r')).rejects.toThrow('task ghost not found')
})

test('network error (connection refused) → "cete-os-server unreachable at <url>"', async () => {
  const f = fakeFetch(() => { throw new TypeError('Unable to connect') })
  const c = new CeteTasksClient(CFG, f.fn)
  await expect(c.myTasks()).rejects.toThrow('cete-os-server unreachable at http://127.0.0.1:8787')
})

test('other non-2xx with {ok:false,error} → surfaces the server error', async () => {
  const f = fakeFetch(() => json({ ok: false, error: 'title required' }, 400))
  const c = new CeteTasksClient(CFG, f.fn)
  await expect(c.assignTask({ target: 'b', title: '' })).rejects.toThrow('title required')
})
