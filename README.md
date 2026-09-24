# Forge MCP Server

An MCP server for [Laravel Forge](https://forge.laravel.com) built on Forge API v2. It covers the whole API (except org
administration) with about 20 grouped tools, and keeps responses small so it is cheap to use every day.

## Highlights

- **Token-efficient.** Lists come back as tab-separated tables with sensible default columns. Logs are tailed and
  grep-able. Secrets (deploy tokens, private keys) are hidden unless you ask for them. The full tool set is about
  8–9k tokens of definitions.
- **Names instead of IDs.** Pass `server: "seniors-plus"` or `site: "seniorsplus.org"`; IDs are resolved and cached.
- **Careful paging.** One page by default with a note when more exist. `all: true` fetches everything, up to a safety cap.
- **WP-CLI on every server** through Forge's command API, no SSH key needed, with an automatic database export before
  risky commands.
- **Bulk runs** across many sites, with a mandatory preview.
- **Guarded destructive operations** in a single tool, each needing a preview and a confirmation token.

## Configuration

Requires Node 18+ and a Forge API token.

```json
{
  "mcpServers": {
    "forge": {
      "command": "npx",
      "args": ["-y", "github:tylerthedev819/forge-mcp-server#main", "--tools=destructive"],
      "env": { "FORGE_API_KEY": "…", "FORGE_ORG": "your-org-slug" }
    }
  }
}
```

`FORGE_ORG` is optional; without it the first organization on the token is used.

### Access levels

`--tools=` picks what is exposed. Each level includes the ones before it.

| Value | Exposes |
| --- | --- |
| `readonly` (default) | Reading only |
| `write` | Plus creating, updating, deploying, running commands, reboots |
| `destructive` | Plus `forge_destructive` (deletes, log clearing, backup restores) |

Actions that are not enabled are left out of the tool definitions entirely.

### Requiring your approval for destructive operations

`forge_destructive` always previews first and needs a token on the second call, but the model can supply that token
itself. Make your client ask you before the tool runs:

- **Claude Code:** add `"mcp__forge__forge_destructive"` (use your server's name in place of `forge`) to
  `permissions.ask` in `~/.claude/settings.json`.
- **Claude Desktop:** set the tool to "Always ask" in the connector's tool settings.

## Tools

| Tool | What it does |
| --- | --- |
| `forge_overview` | Every site (or server) in one compact table. Start here. |
| `forge_find` | Find servers and sites by partial name, domain, or IP |
| `forge_servers` | Server details, events, create/update, reboot, power-cycle, restart services |
| `forge_sites` | Site details, create, settings, git, nginx config, healthcheck, composer/npm credentials |
| `forge_domains` | Domains, DNS config, domain nginx, SSL certificates (Let's Encrypt by default) |
| `forge_env` | Read `.env` (optionally selected keys), set individual values, or replace the file |
| `forge_deployments` | Deploy (optionally waiting for the result), history, logs, script, push-to-deploy, hooks, webhooks, deploy key |
| `forge_commands` | Run a shell command in a site directory and get its output; command history |
| `forge_wp` | WP-CLI on any WordPress site by name |
| `forge_bulk` | Run a WP-CLI or shell command across many sites (preview, then run with a token) |
| `forge_logs` | Site logs (application, nginx access/error) and server logs, tailed and filtered |
| `forge_databases` | Databases and database users |
| `forge_backups` | Backup configurations, backups, run a backup now |
| `forge_jobs` | Scheduled jobs for servers and sites |
| `forge_processes` | Background processes / daemons, with logs and restart |
| `forge_ssh_keys` | Authorize SSH keys on one, several, or all servers, for `forge` or each site user |
| `forge_security` | Firewall rules, site security rules, redirect rules |
| `forge_php` | PHP versions and settings (CLI/site default, upload size, execution time, OPcache, FPM/CLI/pool config) |
| `forge_install_wordpress` | New WordPress site: database, Forge WordPress site, optional `wp core install` |
| `forge_options` | Providers, regions, sizes, cloud credentials, VPCs; current user and org |
| `forge_api` | Search a catalog of every endpoint and call any of them (monitors, heartbeats, recipes, integrations, …) |
| `forge_destructive` | Delete any resource, clear logs, restore a backup (with a safety backup first) |

### WP-CLI backups

`forge_wp` and `forge_bulk` (`kind: wp`) export the site database to `~/mcp-backups/<site>-<timestamp>.sql.gz`
before commands that change things: plugin/theme/core installs and updates, `search-replace` without `--dry-run`,
`db import`/`reset`/`query`, and updates or deletes of options, posts, users, and terms. The command only runs if the
export succeeds. Exports older than 14 days are removed. Use `backup: "always"` or `"never"` to override.

### SSH keys on many servers

`forge_ssh_keys` `add` with `every_server: true` (or `servers: [...]`) and `per_site_user: true` authorizes one key for
every site user across the fleet. Anything touching more than one server returns a preview and a token first.
Use a dedicated key for this so it can be revoked on its own.

## Development

```bash
npm install
npm run build
npm test
```

`dist/` is committed so `npx github:…` runs without a build step; rebuild before committing.
Regenerate the endpoint catalog from Forge's spec with:

```bash
curl -o /tmp/forge-openapi.json https://forge.laravel.com/api/docs.openapi
npm run catalog -- /tmp/forge-openapi.json
```

Layout: `src/forge/` holds the API client, formatting, name resolution, command runner, and confirmation tokens;
`src/tools/` holds the tool specs (`define.ts` has the shared helpers and registration logic).

## Disclaimer

Forge MCP server is an independent product and not officially affiliated with, endorsed by, or sponsored by Laravel or
Taylor Otwell. 'Laravel' is a registered trademark owned by Taylor Otwell.

## License

MIT. See [LICENSE](LICENSE.md).
