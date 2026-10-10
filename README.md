[English](README.md) | [简体中文](README.zh-CN.md)

# Pi Smart Subagents

Run isolated child agents in [Pi](https://pi.dev/), with Jev choosing the execution model and local policy controlling tool access.

An independent community fork of Luke Parke's `@parke.dev/pi-subagent` from [LukasParke/pi-extensions](https://github.com/LukasParke/pi-extensions/tree/main/packages/pi-subagent). It retains named agents, parallel and background tasks, worktree isolation and usage accounting, and adds Jev model routing with child capability checks.

<a id="quick-start"></a>
## Installation

Requires Node.js 22.19.0 or newer and Pi. Do not enable this fork and `@parke.dev/pi-subagent` together: both register the same tools.

```bash
pi install npm:@cr1ms0n/pi-subagent
```

Before your first task, configure your TypeSafe API key and candidate models in `~/.pi/subagent.json`. See the [configuration example](docs/REFERENCE.md#jev-routing); keep credentials private and merge changes into any existing configuration.

<a id="delegation"></a>
## Usage

Ask Pi, for example:

> Use a read-only subagent to review this project's directory structure and summarize the main modules.

Jev selects the model, not individual tools. Local policy controls the permitted tool set, and startup checks which capabilities are available in the child. An explicitly requested tool must be available. See the [tool policy and routing reference](docs/REFERENCE.md#jev-routing) for details.

The default **compact** mode keeps ordinary delegation, parallel/background tasks, budgets and worktree management. For advanced request controls such as resume, synthesis and structured output, merge this field into `~/.pi/subagent.json`, then reload or restart Pi after active tasks finish:

```json
{ "toolMode": "full" }
```

See [tool modes](docs/REFERENCE.md#tool-modes) for the field split and upgrade behavior.

Task `timeout_ms` is a reminder, not a stop limit. At the threshold, a foreground call returns the run ID and the same work continues in the background. Use `status`, `wait`, `steer` or `cancel` to decide what happens next. Existing time settings now have this advisory meaning; turn/cost budgets and independent fault checks remain. See [budgets and retries](docs/REFERENCE.md#budgets-and-retries).

- Open `/subagents` to inspect and manage tasks.
- Open `/subagent-cost` to view usage.
- See the [usage reference](docs/REFERENCE.md#quick-usage) for named agents, parallel tasks, background work, worktrees and structured results, or the [TUI guide](docs/UX.md) for keyboard controls.

Model execution and Jev selection may incur separate charges. Planning also invokes Jev; `max_cost` does not cap TypeSafe selector charges. See [cost accounting](docs/COST-ACCOUNTING.md).

Routing sends task text and candidate-model information to the selector. Set `jevRouting.baseUrl` only to a trusted endpoint, since it changes the recipient of routing data and the routing credential. See the [security guide](docs/SECURITY.md).

<a id="license"></a>
## License

[MIT](LICENSE). Copyright (c) 2026 Luke Parke. Fork maintained by cr1ms0n (awoaCrim). Preserve the original copyright and license when redistributing this work.

Thanks to [Linux.do](https://linux.do/).
