---
name: neopi-development
description: Implement, test, build, or publish changes in the NeoPi repository. Routes its code conventions, TUI contracts, native build constraints, and delivery policy to the current task.
---

# NeoPi development

Read only the references that match the work. Paths below are relative to this skill.

| Work | Read before acting |
| --- | --- |
| Change code or tests | [Code conventions](../../../docs/agents/development.md) |
| Change a menu, editor, renderer, search, or tool preview | [TUI contracts](../../../docs/agents/tui-development.md), in addition to code conventions |
| Change Rust or native build configuration | [Native builds](../../../docs/agents/native-development.md), in addition to code conventions |
| Run checks, compile, install, or release | [Build and install](../../../docs/agents/build-install.md) |
| Branch, commit, post to GitHub, or merge | [Repository policy](../../../docs/agents/policy.md) |
| Publish a user-facing change | [Changelog](../../../docs/agents/changelog.md) |
| Add fork behavior or integrate upstream | [Fork maintenance](../../../docs/agents/fork-maintenance.md); upstream releases also use [Upstream sync](../../../docs/agents/upstream-sync.md) |

Use existing domain helpers before adding another implementation. Keep each contract in its owning reference; update that reference when the contract changes.
