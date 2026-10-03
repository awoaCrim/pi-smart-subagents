# Pi Smart Subagents

[English](README.md) | [简体中文](README.zh-CN.md)

在 [Pi](https://pi.dev/) 中运行独立子代理，由 Jev 为每项任务选择执行模型，并由本地策略启用完整的允许工具集。

本项目是 Luke Parke 的 `@parke.dev/pi-subagent` 的独立社区分支，上游来自 [LukasParke/pi-extensions](https://github.com/LukasParke/pi-extensions/tree/main/packages/pi-subagent)。保留上游的命名代理、并行与后台任务、工作树和用量统计，增加 Jev 路由与子代理能力核验。

---

<a id="quick-start"></a>
### 安装

```bash
pi install npm:@cr1ms0n/pi-subagent
```

---

<a id="delegation"></a>
### 使用

首次使用前，在 `~/.pi/subagent.json` 中配置 TypeSafe API key 和候选模型，见[配置示例](docs/REFERENCE.md#jev-routing)。

然后直接对 Pi 说，例如：

> 用只读子代理查看这个项目的目录结构，并总结主要模块。

Jev 只选择执行模型。active 工具、profile 和显式 `tools` 的本地策略决定普通 child 候选集；启动时再与 child 的实际能力协商交集，未显式强制的缺失工具只记录为 omitted/诊断，显式请求但缺失的工具则 fail closed。Pi 自己管理的 native 工具仍由 host 控制。可选的 `jevRouting.baseUrl` 可以指向受信任的完整 `https://` SystemOne 请求 URL；省略时仍精确使用官方默认端点 `https://api.typesafe.ai/v1/systemone`。该值会经过严格校验，修改它也会修改接收最小路由披露数据的目标。完整约束见[配置参考](docs/REFERENCE.md#jev-routing)。

工具分类直接复用 Pi 0.99.0+ 官方 `ToolExposure` 元数据，不再维护包自己的基础设施名单。active 的 `direct` 工具（包括 direct SDK/自定义工具）构成本地普通能力集，在 profile 和显式 `tools` 策略处理后一起启用；Jev 不会逐个选择工具，也不会收到工具描述。`model-only`、`codemode`、`deferred` 定义会自动作为 native managed 工具带入子进程；子进程注册结果会参与能力协商，未显式强制的缺失定义记为 omitted，而是否 active 由 Pi 控制；`hidden` 工具会被排除。没有 exposure 元数据的旧 host 按 Pi 默认的 `direct` 处理。source 元数据只用于来源证明/诊断，annotations 只是作者提示，二者都不是写入安全证明。用户无需为此添加配置。

使用 `/subagents` 查看任务，使用 `/subagent-cost` 查看用量。

并行任务、后台执行、工作树和结构化结果见[使用参考](docs/REFERENCE.md#quick-usage)，键盘操作见 [TUI 指南](docs/UX.md)。

---

<a id="license"></a>
### 许可证

[MIT](LICENSE)。Copyright (c) 2026 Luke Parke。社区分支由 cr1ms0n（awoaCrim）维护。重新分发时请保留原始版权声明和许可证。

译自 [README.md](README.md)，英文文件 blob：`485f09bb4697860d3dc62ccf8de53e34196c2e18`。中英文内容如有差异，以英文为准。

感谢 [Linux.do](https://linux.do/)。
