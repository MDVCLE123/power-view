# marcs-mods

Marc's Claude Code mods, as a plugin marketplace.

## power-view

- **Steps box:** the Progress Only output style, with a live steps box and hidden tool calls.
- **◆ Tools** (`/tray`): model, effort, output style, helper agents, the status line, and every slash command, grouped by source and run with a press.
- **● Agents** (`/agentpane`), two tabs:
  - **Subagents:** Claude's subagents with their current tool, tokens and a Stop button.
  - **Agent CLI** (`/agentcli`): chat with other agent CLIs on the device (Cursor Agent, Codex, …), with a model picker and hand-off to Claude.
- **☰ Sessions** (`/sessions`): every session in one list, grouped Needs input, Working, Idle, Done and Earlier (closed conversations read from `~/.claude/projects`).
  - Type a task to start a new background session in a folder you pick.
  - Each row is named by its conversation's title, with its last prompt dimmed underneath (or how the reply began, where two rows were asked the same). Earlier shows the newest 10; **m** shows the rest.
  - Pick a row to peek at its last prompt and reply; **Resume here** picks a closed or finished conversation up in this terminal (moving Claude to its folder first). A background session that's still running opens in a new iTerm tab instead.
  - **Resume in bg** brings a closed conversation back as a background session in agent view; **Stop**, **Delete** and **Copy cmd** too.
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
