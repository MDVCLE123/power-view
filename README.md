# marcs-mods

Marc's Claude Code mods, as a plugin marketplace.

## power-view

- **Steps box:** the Progress Only output style, with a live steps box and hidden tool calls.
- **◆ Tools** (`/tray`): model, effort, output style, helper agents and the status line.
- **● Agents** (`/agentpane`), two tabs:
  - **Subagents:** Claude's subagents with their current tool, tokens and a Stop button.
  - **Agent CLI** (`/agentcli`): chat with other agent CLIs on the device (Cursor Agent, Codex, …), with a model picker and hand-off to Claude.
- **▤ Project** (`/filespane`): a file tree with git marks, find by name or contents, a file viewer and editor, and Open project.

## Install

At a Claude Code prompt in a terminal:

```
/plugin marketplace add MDVCLE123/power-view
/plugin install power-view@marcs-mods
```

Pick the user scope so it loads in every session.

Everything is in the plugin; there is nothing else to install. The Tools tray reads and writes `~/.claude/settings.json` itself. Its **Status line** row turns on the plugin's own status line (`plugins/power-view/bin/statusline`, which needs `python3`).

## Update

After pushing a change here, on each device:

```bash
claude plugin marketplace update marcs-mods
claude plugin update power-view@marcs-mods
```

Then `/reload-plugins` in a running session, or start a new one.

## Develop

```bash
claude plugin validate plugins/power-view
claude plugin test plugins/power-view
```
