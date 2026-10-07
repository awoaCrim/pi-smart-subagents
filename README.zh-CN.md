[English](README.md) | [简体中文](README.zh-CN.md)

# Pi Smart Subagents

在 [Pi](https://pi.dev/) 中运行独立子代理，由 Jev 选择执行模型，本地策略控制工具访问权限。

本项目是 Luke Parke 的 `@parke.dev/pi-subagent` 的独立社区分支，上游来自 [LukasParke/pi-extensions](https://github.com/LukasParke/pi-extensions/tree/main/packages/pi-subagent)。保留命名代理、并行与后台任务、工作树隔离和用量统计，增加 Jev 模型路由与子代理能力检查。

<a id="quick-start"></a>
## 安装

需要 Node.js 22.19.0 或更高版本及 Pi。不要同时启用本分支和 `@parke.dev/pi-subagent`，两者会注册相同的工具。

```bash
pi install npm:@cr1ms0n/pi-subagent
```

首次使用前，在 `~/.pi/subagent.json` 中配置 TypeSafe API key 和候选模型。参阅[配置示例](docs/REFERENCE.md#jev-routing)，妥善保管凭据；已有配置时，请合并修改，不要直接覆盖。

<a id="delegation"></a>
## 使用

直接对 Pi 说，例如：

> 用只读子代理查看这个项目的目录结构，并总结主要模块。

Jev 选择模型，不逐个选择工具。本地策略控制允许的工具集，启动时检查子代理实际可用的能力。显式请求的工具必须可用，详细规则见[工具策略与路由参考](docs/REFERENCE.md#jev-routing)。

默认的 **compact（精简）** 模式保留常规委派、并行与后台任务、预算和工作树管理。如需恢复会话、汇总、结构化输出等高级请求参数，请将以下字段合并到 `~/.pi/subagent.json`，等活动任务结束后重新加载或重启 Pi：

```json
{ "toolMode": "full" }
```

参数划分和升级行为见[工具模式说明](docs/REFERENCE.md#tool-modes)。

- 使用 `/subagents` 查看和管理任务。
- 使用 `/subagent-cost` 查看用量。
- 命名代理、并行任务、后台执行、工作树和结构化结果见[使用参考](docs/REFERENCE.md#quick-usage)，键盘操作见 [TUI 指南](docs/UX.md)。

模型执行与 Jev 选择可能分别产生费用。规划操作也会调用 Jev；`max_cost` 不限制 TypeSafe 选择器费用。详见[费用统计说明](docs/COST-ACCOUNTING.md)。

路由会向选择器发送任务文本和候选模型信息。仅将 `jevRouting.baseUrl` 设置为受信任的端点，因为它会改变路由数据和路由凭据的接收方。详见[安全说明](docs/SECURITY.md)。

<a id="license"></a>
## 许可证

[MIT](LICENSE)。Copyright (c) 2026 Luke Parke。社区分支由 cr1ms0n（awoaCrim）维护。重新分发时请保留原始版权声明和许可证。

译自 [README.md](README.md)，英文文件 blob：`cb66c38c98d213e0868fafb6f3487d4ae103cf46`。中英文内容如有差异，以英文为准。

感谢 [Linux.do](https://linux.do/)。
