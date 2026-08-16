# rdc

A Tauri 2.0 + React 19 rewrite of `desktop-plus` (a GitHub-Desktop-derived Electron app),
with the backend rewritten in Rust. 

- Primary target platform is Linux, for both development
and end-user usage.

[`PROJECT_STRUCTURE.md`](./PROJECT_STRUCTURE.md) is how the frontend is laid out and where a new
file goes — the shortest useful starting point, and the only one whose rules the build enforces.

[`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) holds the phased migration plan and the architectural
decisions behind it; [`MIGRATION_MAP.md`](./MIGRATION_MAP.md) records where each piece of the
original codebase ended up. Both are large historical records rather than day-to-day reading —
[`REMAINING.md`](./REMAINING.md) is the short list of what is still open.

For local setup, day-to-day commands, and how to run the test suites (including E2E), see
[`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
