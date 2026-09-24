#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configureClient, request } from './forge/client.js'
import { describe, enabledActions, Level, runAction, schemaFor } from './tools/define.js'
import { TOOLS } from './tools/index.js'

const VERSION = '1.0.0'

function argValue(name: string): string | undefined {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  return arg?.slice(name.length + 3)
}

/** --tools=readonly | write | destructive (each includes the ones before it). Default readonly. */
function levels(): Level[] {
  const requested = (argValue('tools') ?? 'readonly').split(',').map(s => s.trim())
  const valid: Level[] = ['readonly', 'write', 'destructive']
  const bad = requested.filter(r => !valid.includes(r as Level))
  if (bad.length) {
    console.error(`Invalid --tools value(s): ${bad.join(', ')}. Use readonly, write, destructive.`)
    process.exit(1)
  }
  if (requested.includes('destructive')) return valid
  if (requested.includes('write')) return ['readonly', 'write']
  return ['readonly']
}

async function main() {
  const apiKey = argValue('api-key') ?? process.env.FORGE_API_KEY
  if (!apiKey) {
    console.error('FORGE_API_KEY (or --api-key) is required.')
    process.exit(1)
  }
  let org = argValue('org') ?? process.env.FORGE_ORG ?? ''
  configureClient({ apiKey, org })
  if (!org) {
    const body = await request<{ data?: { attributes?: { slug?: string } }[] }>('GET', '/orgs')
    org = body?.data?.[0]?.attributes?.slug ?? ''
    if (!org) throw new Error('Could not determine your Forge organization; set FORGE_ORG.')
    configureClient({ apiKey, org })
  }

  const enabled = levels()
  const server = new McpServer({ name: 'forge', version: VERSION }, { capabilities: { tools: {} } })
  let count = 0
  for (const spec of TOOLS) {
    const actions = enabledActions(spec, enabled)
    if (!actions.length) continue
    const readOnly = actions.every(a => spec.actions[a].level === 'readonly')
    server.tool(
      spec.name,
      describe(spec, actions),
      schemaFor(spec, actions),
      { readOnlyHint: readOnly, destructiveHint: spec.name === 'forge_destructive', openWorldHint: true },
      async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text' as const, text: await runAction(spec, actions, args) }] }
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      }
    )
    count++
  }
  console.error(`Forge MCP ${VERSION}: org ${org}, levels ${enabled.join('+')}, ${count} tools`)
  await server.connect(new StdioServerTransport())
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
