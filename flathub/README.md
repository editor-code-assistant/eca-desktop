# Flathub packaging

This directory is the submission-ready content for the future
`github.com/flathub/dev.eca.desktop` repo. It repackages the released
debs (multi-arch, provenance-attested) rather than rebuilding Electron
from source.

`dev.eca.desktop.metainfo.xml` here is a snapshot of
`build/dev.eca.desktop.metainfo.xml`. After the app is on Flathub, the
copy in the flathub repo is maintained by their update bot
(release entries) and this snapshot no longer matters.

## Test locally

```bash
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08
flatpak-builder --user --install --force-clean /tmp/eca-fb-build flathub/dev.eca.desktop.yml
flatpak run dev.eca.desktop
```

Requires `flatpak-builder` and `appstreamcli` (`appstream` package, plus
`appstream-compose` on Debian/Ubuntu).

## Submit

1. Fork `github.com/flathub/flathub`, create a branch off `new-pr`.
2. Copy the three `dev.eca.desktop.*` files into the fork root.
3. Open a PR against the `new-pr` branch of `flathub/flathub`.
4. In the PR description, preempt the two expected review questions:
   - `--talk-name=org.freedesktop.Flatpak`: the app spawns the eca
     server on the host so the coding agent can use the user's real
     toolchain (git, shells, MCP servers). Same access class as IDE
     flatpaks; results in a "full session access" badge.
   - Runtime download: the app downloads the upstream eca server binary
     into `~/.eca-desktop`, SHA-256 verified against release checksums,
     because server releases outpace app releases. Same pattern as
     Bottles/Lutris runners.

## After the PR is merged

- Flathub creates `flathub/dev.eca.desktop` and invites you as
  collaborator; the buildbot publishes to stable.
- The update bot (flatpak-external-data-checker, driven by the
  `x-checker-data` blocks in the manifest) opens a PR there on every
  new GitHub release; merging it ships the update. Optionally enable
  automerge by adding `flathub.json` with
  `{"automerge-flathubbot-prs": true}`.
- Verify the app (Flathub website -> app settings -> verification) via
  a token on https://eca.dev or a DNS TXT record to get the verified
  badge.
- Update the eca.dev install docs to point Linux users at Flathub.
