# Vendored test rig

`rig.mjs` and `mock-llm.mjs` are copied from Jake's nix-config,
`skills/new-dsh-plugin/scripts/`, at commit
`6a7e6130ea0f45cdf0f3ea51b99565c9264df564` (2026-10-11).

Tests import them by relative path (`./rig/rig.mjs`) only. Never import the
installed skill (`~/.agents/...`) or nix-config at test time: those paths do
not exist in CI or the Nix sandbox.

Upstream sha256 at that commit:

| File | sha256 |
|---|---|
| rig.mjs | `4a79aeb02e5c419eb4dbf16396eb0812e1343147ddf1fe084f775c99e0382d93` |
| mock-llm.mjs | `a44562f2f5f1754692fcc3f28f5e19d22f83ddf7b98b423ce90ddc607d8695f1` |

Local changes (keep this list complete when re-vendoring):

1. `rig.mjs` `startTui`: tmux runs with `-f /dev/null` as well as a private
   `-L` socket, so no user `~/.tmux.conf` is read.
