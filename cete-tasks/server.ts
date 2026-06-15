#!/usr/bin/env bun
/**
 * cete-tasks — agent-facing task tools for Claude Code, backed by cete-os-server.
 *
 * This is the drop-in replacement for the task primitive that local-ipc carried
 * before 0.3.0: the SAME six tool names (assign_task / my_tasks / claim_task /
 * complete_task / fail_task / cancel_task), but implemented as a thin client over
 * cete-os-server's REST API (SQLite SSOT) rather than a local filesystem store.
 *
 * No nudge/watch logic lives here. Delivery is already handled out-of-band: when
 * a task is assigned, cete-os-server drops a `from="tasks"` message into the
 * target's local-ipc inbox, which local-ipc delivers as a channel message telling
 * the agent to call my_tasks. This server is purely request/response.
 *
 * Config (env):
 *   CETE_OS_SERVER_URL    base URL of cete-os-server (default http://127.0.0.1:8787)
 *   CETE_OS_SERVER_SECRET shared secret, sent as the X-Auth header (required)
 *   CETE_TASKS_AGENT_NAME this agent's identity; falls back to LOCAL_IPC_AGENT_NAME
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { CeteTasksClient } from './client'

const PLUGIN_VERSION = '0.1.0'

const AGENT = process.env.CETE_TASKS_AGENT_NAME ?? process.env.LOCAL_IPC_AGENT_NAME
if (!AGENT) {
  process.stderr.write(
    'cete-tasks: agent identity required — set CETE_TASKS_AGENT_NAME or LOCAL_IPC_AGENT_NAME in the launcher.\n',
  )
  process.exit(1)
}

const SERVER_URL = process.env.CETE_OS_SERVER_URL ?? 'http://127.0.0.1:8787'
const SECRET = process.env.CETE_OS_SERVER_SECRET
if (!SECRET) {
  process.stderr.write('cete-tasks: CETE_OS_SERVER_SECRET required (X-Auth for cete-os-server).\n')
  process.exit(1)
}

const client = new CeteTasksClient({ url: SERVER_URL, secret: SECRET, agent: AGENT })

const mcp = new Server(
  { name: 'cete-tasks', version: PLUGIN_VERSION },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${AGENT}". These tools manage durable, completion-tracked tasks via cete-os-server (${SERVER_URL}).`,
      '',
      'Use a task when work must be tracked to done/failed or must survive the target being offline; use the local-ipc `send` message tool for conversational replies.',
      '',
      'When you are assigned a task, cete-os-server delivers a `from="tasks"` nudge through local-ipc telling you to call `my_tasks`. The server is the source of truth: a missed nudge is always recoverable by calling `my_tasks`.',
      '',
      'Tasks require cete-os-server to be reachable. If it is down, these tools return "cete-os-server unreachable" — local-ipc messaging still works independently.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'assign_task',
      description:
        'Create a durable, completion-tracked task for another agent (or yourself). ' +
        'The target is nudged to call my_tasks. Use this when work must be tracked to done/failed; ' +
        'use the local-ipc `send` tool for conversational messages that just need a reply.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Target agent name (their LOCAL_IPC_AGENT_NAME). Offline targets are queued.' },
          title: { type: 'string', description: 'Short task title. Max 200 chars.' },
          body: { type: 'string', description: 'Optional detail.' },
          priority: { type: 'number', description: 'Optional; higher sorts first. Default 0.' },
        },
        required: ['target', 'title'],
      },
    },
    {
      name: 'my_tasks',
      description: 'List tasks targeted at you. Defaults to active (open + claimed). Pass `status` to filter.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'claimed', 'done', 'failed', 'cancelled'], description: 'Optional single status filter.' },
        },
      },
    },
    {
      name: 'claim_task',
      description: 'Mark one of your open tasks as claimed (you are working on it).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'complete_task',
      description: 'Mark a claimed task done, with an optional result string.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, result: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'fail_task',
      description: 'Mark a claimed task failed, with an optional error string.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, error: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'cancel_task',
      description: 'Cancel an open or claimed task (producer or target may cancel).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
}))

const text = (s: string) => ({ content: [{ type: 'text', text: s }] })

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const args = req.params.arguments ?? {}
  if (name === 'assign_task') {
    const a = z.object({ target: z.string(), title: z.string(), body: z.string().optional(), priority: z.number().optional() }).parse(args)
    const task = await client.assignTask(a)
    return text(`task ${task.id} created for ${task.target}`)
  }
  if (name === 'my_tasks') {
    const a = z.object({ status: z.enum(['open', 'claimed', 'done', 'failed', 'cancelled']).optional() }).parse(args)
    const tasks = await client.myTasks(a.status)
    return text(JSON.stringify(tasks, null, 2))
  }
  if (name === 'claim_task') {
    const a = z.object({ id: z.string() }).parse(args)
    const task = await client.claimTask(a.id)
    return text(`task ${task.id} -> ${task.status}`)
  }
  if (name === 'complete_task') {
    const a = z.object({ id: z.string(), result: z.string().optional() }).parse(args)
    const task = await client.completeTask(a.id, a.result)
    return text(`task ${task.id} -> ${task.status}`)
  }
  if (name === 'fail_task') {
    const a = z.object({ id: z.string(), error: z.string().optional() }).parse(args)
    const task = await client.failTask(a.id, a.error)
    return text(`task ${task.id} -> ${task.status}`)
  }
  if (name === 'cancel_task') {
    const a = z.object({ id: z.string() }).parse(args)
    const task = await client.cancelTask(a.id)
    return text(`task ${task.id} -> ${task.status}`)
  }
  throw new Error(`unknown tool: ${name}`)
})

const transport = new StdioServerTransport()
await mcp.connect(transport)

process.stderr.write(`cete-tasks: agent=${AGENT} server=${SERVER_URL}\n`)
