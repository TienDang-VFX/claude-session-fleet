#!/usr/bin/env node
// Adds the session-fleet Codex hook to ~/.codex/hooks.json for the events it follows, keeping every other hook.
// Run again at any time: an entry already there is left as it is. `--remove` takes them out.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-hook.mjs').split(path.sep).join('/')
const command = `node "${script}"`
const file = path.join(os.homedir(), '.codex', 'hooks.json')
const remove = process.argv.includes('--remove')

let config = { hooks: {} }
if (fs.existsSync(file)) {
  config = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.copyFileSync(file, `${file}.bak-session-fleet`)
}
config.hooks ??= {}
const ours = entry => (entry.hooks ?? []).some(h => String(h.command ?? '').includes('fleet-hook.mjs'))
for (const event of EVENTS) {
  const entries = (config.hooks[event] ?? []).filter(e => !ours(e))
  if (!remove) entries.push({ hooks: [{ type: 'command', command, timeout: 10 }] })
  if (entries.length) config.hooks[event] = entries
  else delete config.hooks[event]
}
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
console.log(`${remove ? 'Removed from' : 'Installed in'} ${file}: ${EVENTS.join(', ')} -> ${command}`)
