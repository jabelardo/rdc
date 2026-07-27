# rdc

A Tauri 2.0 + React 19 rewrite of `desktop-plus` (a GitHub-Desktop-derived Electron app),
with the backend rewritten in Rust. 

- Primary target platform is Linux, for both development
and end-user usage.

See [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) for the phased migration plan and the
architectural decisions behind it, and [`MIGRATION_MAP.md`](./MIGRATION_MAP.md) for where each
piece of the original codebase ends up.

For local setup, day-to-day commands, and how to run the test suites (including E2E), see
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
