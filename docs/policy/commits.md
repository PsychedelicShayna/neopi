# Commits

Commit timing, message format, trailers, and signing: see the workspace AGENTS.md (parent of this repository). The former AGENTS.md rule "NEVER commit unless asked" is retired; commit on topic branches in worktrees as pipeline work.

## Signer

Select the agent key explicitly on every commit; leave the repository's signing configuration untouched:

```sh
git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub …
git verify-commit HEAD
```

Maintainer merge-commit subjects: `Merge PR #<number>: <conventional PR subject> (@<author>)` (AGENTS.md › Commands).

## Identity

- Now: agents act under the owner's GitHub account. The NOTE comment header names the model; the agent SSH signing key is the technical discriminator (its commits show as the owner's only because the key is on her account).
- Next: a machine account or the sentinel GitHub App holds the agent signing key. GitHub then marks agent-key commits attributed to the owner as Unverified, and a "require verified signatures" ruleset rejects them, making "humans only merge/commit as themselves" enforceable. App comments carry the bot badge; the NOTE header still names the model.
