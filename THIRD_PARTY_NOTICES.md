# Third-party notices

Jitang Simmer 的 AI Token 解析 sidecar 使用以下第三方开源组件：

## tokscale-core

- Project: [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale)
- Pinned revision: `b069c85d530c35ba1a3517e80aaa8423428dccd8`
- License: MIT
- Usage: Codex、ZCode 与 DeepSeek Harness 本地会话用量解析

Jitang Simmer 只调用 `tokscale-core` 的本地解析能力；不会使用其定价或远程查询功能。依赖的完整许可证文本由 Cargo 在构建时随对应源码包提供。
