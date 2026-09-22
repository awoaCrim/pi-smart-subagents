# Pi Smart Subagents

[English](README.md) | [简体中文](README.zh-CN.md)

Run isolated child agents in [Pi](https://pi.dev/), with Jev selecting a model and tools for each task.

An independent community fork of Luke Parke's `@parke.dev/pi-subagent` from [LukasParke/pi-extensions](https://github.com/LukasParke/pi-extensions/tree/main/packages/pi-subagent). It retains the upstream engine's named agents, parallel and background tasks, worktrees and usage accounting, and adds Jev routing with child capability verification.

---

<a id="quick-start"></a>
### Installation

```bash
pi install npm:@cr1ms0n/pi-subagent
```

---

<a id="delegation"></a>
### Usage

Before your first task, configure your TypeSafe API key and candidate models in `~/.pi/subagent.json`. See the [configuration example](docs/REFERENCE.md#jev-routing).

Then ask Pi, for example:

> Use a read-only subagent to review this project's directory structure and summarize the main modules.

Jev chooses the model and tools. Open `/subagents` to inspect tasks and `/subagent-cost` to view usage.

See the [usage reference](docs/REFERENCE.md#quick-usage) for parallel tasks, background work, worktrees and structured results, or the [TUI guide](docs/UX.md) for keyboard controls.

---

<a id="license"></a>
### License

[MIT](LICENSE). Copyright (c) 2026 Luke Parke. Fork maintained by cr1ms0n (awoaCrim). Preserve the original copyright and license when redistributing this work.

Thanks to [Linux.do](https://linux.do/).
