/**
 * Thin REST client for cete-os-server's task API. Each agent-facing task tool
 * maps to exactly one HTTP call; this module owns the request shaping and the
 * server↔agent error translation. Kept free of MCP concerns so it is unit
 * testable with an injected fetch.
 */

export interface CeteConfig {
  /** Base URL of cete-os-server, e.g. http://127.0.0.1:8787 */
  url: string
  /** Shared secret sent as the `X-Auth` header on every request. */
  secret: string
  /** This agent's identity — stamped as created_by / actor on writes, and the my_tasks target. */
  agent: string
}

export interface Task {
  id: string
  target: string
  title: string
  body: string
  status: 'open' | 'claimed' | 'done' | 'failed' | 'cancelled'
  priority: number
  created_by: string
  result: string | null
  error: string | null
  nudged_at: string | null
  created_at: string
  updated_at: string
}

const ACTIVE: Task['status'][] = ['open', 'claimed']

export class CeteTasksClient {
  private url: string
  constructor(private cfg: CeteConfig, private fetchFn: typeof fetch = fetch) {
    this.url = cfg.url.replace(/\/+$/, '')
  }

  async assignTask(a: { target: string; title: string; body?: string; priority?: number }): Promise<Task> {
    const res = await this.req('POST', '/tasks', {
      target: a.target, title: a.title, body: a.body, priority: a.priority, created_by: this.cfg.agent,
    })
    return res.task
  }

  async myTasks(status?: Task['status']): Promise<Task[]> {
    const qs = `?target=${encodeURIComponent(this.cfg.agent)}` + (status ? `&status=${status}` : '')
    const res = await this.req('GET', `/tasks${qs}`)
    const tasks: Task[] = res.tasks
    return status ? tasks : tasks.filter(t => ACTIVE.includes(t.status))
  }

  claimTask(id: string): Promise<Task> {
    return this.transition('claim', id, {})
  }
  completeTask(id: string, result?: string): Promise<Task> {
    return this.transition('complete', id, { result })
  }
  failTask(id: string, error?: string): Promise<Task> {
    return this.transition('fail', id, { error })
  }
  cancelTask(id: string): Promise<Task> {
    return this.transition('cancel', id, {})
  }

  private async transition(verb: string, id: string, extra: Record<string, unknown>): Promise<Task> {
    const res = await this.req('POST', `/tasks/${encodeURIComponent(id)}/${verb}`, { ...extra, actor: this.cfg.agent }, { verb, id })
    return res.task
  }

  private async req(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    ctx: { verb?: string; id?: string } = {},
  ): Promise<any> {
    const init: RequestInit = { method, headers: { 'X-Auth': this.cfg.secret } }
    if (body !== undefined) {
      ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await this.fetchFn(`${this.url}${path}`, init)
    } catch {
      // fetch rejects only on network-level failure (server down, DNS, refused).
      throw new Error(`cete-os-server unreachable at ${this.url}`)
    }
    const data = await res.json().catch(() => ({}) as any)
    if (!res.ok) {
      const serverErr = data?.error ?? `HTTP ${res.status}`
      if (res.status === 404 && ctx.id) throw new Error(`task ${ctx.id} not found`)
      if (res.status === 409 && ctx.verb) throw new Error(`cannot ${ctx.verb}: ${serverErr}`)
      throw new Error(String(serverErr))
    }
    return data
  }
}
