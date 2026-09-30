# Pi Smart Subagents

[English](README.md) | [简体中文](README.zh-CN.md)

在 [Pi](https://pi.dev/) 中运行独立子代理，由 Jev 为每项任务选择模型和工具。

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

Jev 会选择模型和工具。可选的 `jevRouting.baseUrl` 可以指向受信任的完整 `https://` SystemOne 请求 URL；省略时仍精确使用官方默认端点 `https://api.typesafe.ai/v1/systemone`。该值会经过严格校验，修改它也会修改接收最小路由披露数据的目标。完整约束见[配置参考](docs/REFERENCE.md#jev-routing)。

需要在 Jev 的普通工具选择之外保留基础设施工具时，可在同一配置文件的顶层设置 `passthroughTools` 字符串数组，默认 `[]`。填写准确的已注册工具名，没有内置预设。这表示你明确信任这些工具不会修改项目文件，也允许它们用于只读 profile；扩展不会自动证明自定义工具的副作用。已知写入工具、不安全的 builtin 和子任务派发工具不能使用这个例外。启动时每个名称都必须有已注册的定义，是否激活则由工具所属的 host 控制。详见 [passthrough 工具配置](docs/REFERENCE.md#passthrough-tools)。

使用 `/subagents` 查看任务，使用 `/subagent-cost` 查看用量。

并行任务、后台执行、工作树和结构化结果见[使用参考](docs/REFERENCE.md#quick-usage)，键盘操作见 [TUI 指南](docs/UX.md)。

---

<a id="license"></a>
### 许可证

[MIT](LICENSE)。Copyright (c) 2026 Luke Parke。社区分支由 cr1ms0n（awoaCrim）维护。重新分发时请保留原始版权声明和许可证。

译自 [README.md](README.md)，英文文件 blob：`00343e888177a035b323552ce53e1f4aa17cb0ad`。中英文内容如有差异，以英文为准。

感谢 [Linux.do](https://linux.do/)。
