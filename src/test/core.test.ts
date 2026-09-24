import { describe, expect, it } from '@jest/globals'
import { flatten, unwrap } from '../forge/client.js'
import { issueToken, redeemToken } from '../forge/confirm.js'
import { clip, listFooter, project, record, table, tailLines } from '../forge/format.js'
import { isRiskyWp, wpCommand } from '../tools/commands.js'
import { describe as describeTool, enabledActions, schemaFor, ToolSpec } from '../tools/define.js'
import { mergeEnv } from '../tools/sites.js'
import { TOOLS } from '../tools/index.js'

describe('client', () => {
  it('flattens JSON:API resources with relationship ids', () => {
    const r = flatten({ id: 5, type: 'sites', attributes: { name: 'a.com' }, relationships: { server: { data: { id: '9', type: 'servers' } } } })
    expect(r).toEqual({ id: '5', _type: 'sites', name: 'a.com', server_id: '9' })
  })
  it('unwraps lists and single records, passes other bodies through', () => {
    expect(unwrap({ data: [{ id: 1, attributes: { x: 1 } }] })).toEqual([{ id: '1', _type: undefined, x: 1 }])
    expect(unwrap({ data: { id: 2, attributes: {} } })).toEqual({ id: '2', _type: undefined })
    expect(unwrap('plain')).toBe('plain')
  })
})

describe('format', () => {
  const servers = [
    { id: '1', _type: 'servers', name: 'web', ip_address: '1.2.3.4', php_version: 'php84', region: 'NY', size: '1', connection_status: 'ok', local_public_key: 'ssh-ed25519 AAA' },
  ]
  it('renders default columns as TSV and omits secrets', () => {
    const out = table(servers)
    expect(out.split('\n')[0]).toBe('id\tname\tip_address\tphp_version\tregion\tsize\tconnection_status')
    expect(out).not.toContain('ssh-ed25519')
  })
  it('honors explicit fields', () => {
    expect(table(servers, { fields: ['name', 'local_public_key'] })).toContain('ssh-ed25519')
  })
  it('hides tokens in records unless full', () => {
    const rec = { id: '1', deployment_url: 'https://x?token=abc', name: 'a' }
    expect(project(rec, {})).toEqual({ id: '1', name: 'a' })
    expect(record(rec, { full: true })).toContain('token=abc')
  })
  it('clips long text keeping head and tail', () => {
    const out = clip('a'.repeat(5000) + 'END', 1000)
    expect(out.length).toBeLessThan(1100)
    expect(out.endsWith('END')).toBe(true)
  })
  it('tails and greps logs', () => {
    const log = ['one error', 'two', 'three error', 'four'].join('\n')
    expect(tailLines(log, 1, 'error')).toBe('[1 earlier lines omitted]\nthree error')
  })
  it('explains paging in the footer', () => {
    expect(listFooter(25, 'abc')).toContain('cursor=abc')
    expect(listFooter(3, null)).toBe('\n[3 items]')
  })
})

describe('wp-cli', () => {
  const site = { id: '1', name: 'shop.example.com', web_directory: '/home/shop/shop.example.com/public' }
  it('flags risky commands only', () => {
    expect(isRiskyWp('plugin update --all')).toBe(true)
    expect(isRiskyWp('core update')).toBe(true)
    expect(isRiskyWp('search-replace a b')).toBe(true)
    expect(isRiskyWp('search-replace a b --dry-run')).toBe(false)
    expect(isRiskyWp('option update blogname X')).toBe(true)
    expect(isRiskyWp('plugin list --format=csv')).toBe(false)
    expect(isRiskyWp('core version')).toBe(false)
  })
  it('prefixes a DB export for risky commands and gates the main command on it', () => {
    const { command, backedUp } = wpCommand(site, 'plugin update --all')
    expect(backedUp).toBe(true)
    expect(command).toContain("db export")
    expect(command.indexOf('db export')).toBeLessThan(command.indexOf('plugin update'))
    expect(command).toMatch(/&& wp --path='\/home\/shop\/shop.example.com\/public' plugin update --all --no-color$/)
  })
  it('respects backup=never and strips a leading "wp"', () => {
    const { command, backedUp } = wpCommand(site, 'wp plugin update --all', 'never')
    expect(backedUp).toBe(false)
    expect(command).toBe("wp --path='/home/shop/shop.example.com/public' plugin update --all --no-color")
  })
})

describe('env merge', () => {
  it('updates in place, appends new keys, quotes when needed', () => {
    const out = mergeEnv('APP_NAME=Old\nDB_HOST=127.0.0.1\n', { APP_NAME: 'New App', MAIL_HOST: 'smtp.x.com' })
    expect(out).toBe('APP_NAME="New App"\nDB_HOST=127.0.0.1\nMAIL_HOST=smtp.x.com\n')
  })
})

describe('confirmation tokens', () => {
  it('are single-use and bound to one operation', () => {
    const t = issueToken('delete:/a')
    expect(redeemToken(t, 'delete:/b')).toBe(false)
    expect(redeemToken(t, 'delete:/a')).toBe(true)
    expect(redeemToken(t, 'delete:/a')).toBe(false)
  })
})

describe('tool levels', () => {
  it('readonly mode exposes no write or destructive actions', () => {
    for (const spec of TOOLS) {
      for (const a of enabledActions(spec, ['readonly'])) expect(spec.actions[a].level).toBe('readonly')
    }
    expect(TOOLS.find(t => t.name === 'forge_destructive')!.actions.run.level).toBe('destructive')
  })
  it('only forge_destructive carries destructive actions', () => {
    const offenders = TOOLS.filter(t => t.name !== 'forge_destructive' && Object.values(t.actions).some(a => a.level === 'destructive'))
    expect(offenders.map(t => t.name)).toEqual([])
  })
  it('single-action tools take no action parameter', () => {
    const logs = TOOLS.find(t => t.name === 'forge_logs') as ToolSpec
    expect(Object.keys(schemaFor(logs, ['run']))).not.toContain('action')
    expect(describeTool(logs, ['run'])).toBe(logs.summary)
  })
  it('tool names are unique', () => {
    const names = TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('type attribute', () => {
  it('keeps a resource attribute named type separate from the JSON:API type', () => {
    const r = flatten({ id: 1, type: 'monitors', attributes: { type: 'cpu', threshold: 80 } })
    expect(r.type).toBe('cpu')
    expect(r._type).toBe('monitors')
    expect(table([r]).split('\n')[0]).toBe('id\ttype\toperator\tthreshold\tminutes\tstatus\tstate')
  })
})
