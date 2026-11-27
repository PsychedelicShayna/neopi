# Working in NeoPi

Unless the request names another package, work concerns `packages/coding-agent/`, the CLI implementation. In questions about this repository, "the agent" means that implementation.

Read `README.md` for product context, `CONTEXT.md` for repository terms, and `CONTEXT-MAP.md` when locating a package or domain. Preserve unexpected local edits.

## Task-specific guidance

Use the [neopi-development skill](.agents/skills/neopi-development/SKILL.md) for development. Read the matching references before acting, rather than loading every procedure at startup.

| Task | Reference |
| --- | --- |
| Code or tests | [Code conventions](docs/agents/development.md) |
| Menus, editors, rendering, search, previews | [TUI contracts](docs/agents/tui-development.md) |
| Rust or native build configuration | [Native builds](docs/agents/native-development.md) |
| Check, build, install, release | [Build and install](docs/agents/build-install.md) |
| Branches, commits, GitHub posts, merges | [Repository policy](docs/agents/policy.md) |
| User-facing changes | [Changelog](docs/agents/changelog.md) |
| Fork behavior, upstream integration | [Fork maintenance](docs/agents/fork-maintenance.md), [Upstream sync](docs/agents/upstream-sync.md) |
| Agent, role or lifecycle design | [Design philosophy](docs/agents/philosophy.md) |
| Issue classification or reconciliation | [Triage](docs/agents/triage.md), [Label meanings](docs/agents/triage-labels.md) |
| Issue tracker or publication seat | [Issue tracker](docs/agents/issue-tracker.md), [Issue Funnel](docs/agents/issue-funnel.md) |
| Domain documentation | [Domain workflow](docs/agents/domain.md) |
| Request review or assess merge eligibility | [Review mechanics](docs/agents/pr-review-bots.md) |

These files are the repository's policy home for any harness or fresh clone.
