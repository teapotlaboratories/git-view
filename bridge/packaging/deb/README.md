# gitview-bridge Debian package

Builds a `.deb` that installs the GitView bridge as a **systemd service**
(`gitview-bridge.service`).

## Build

```sh
cd bridge/packaging/deb
./build.sh            # → bridge/build/deb/gitview-bridge_<version>_all.deb
```

`build.sh` compiles the bridge (`tsc`), installs its **production** dependencies
(no dev, no optional — see *Claude support* below), and assembles the package.
Needs `node`/`npm` and `dpkg-deb`. The package is `Architecture: all` (pure-JS
deps); if a native module ever slips in, the script pins it to the host arch.

## Install

```sh
sudo dpkg -i gitview-bridge_<version>_all.deb
# resolve any missing deps (git; nodejs is Recommended):
sudo apt-get -f install
```

The package installs:

| Path | Purpose |
| --- | --- |
| `/opt/gitview-bridge/` | the bridge (`dist/`, `node_modules/`, `bin/gitview-bridge`) |
| `/etc/gitview-bridge/config.yaml` | configuration (conffile) |
| `/etc/default/gitview-bridge` | service environment (e.g. `GITVIEW_NODE`) |
| `/lib/systemd/system/gitview-bridge.service` | the systemd unit |
| `/var/lib/gitview-bridge/` | state — tokens + audit log (`StateDirectory`) |

`postinst` creates a `gitview-bridge` system user, enables the unit, and prints
next steps. The service is **not auto-started** — configure it first.

## Configure & run

1. Edit `/etc/gitview-bridge/config.yaml` — add your `repos:` (the `gitview-bridge`
   user must be able to read/write those paths and run `git` in them).
2. **Node.js >= 20 is required.** The launcher looks for node on the system `PATH`
   and in `/usr/bin` / `/usr/local/bin`. If node lives elsewhere (nvm, `~/.local`),
   set it in `/etc/default/gitview-bridge`:
   ```sh
   GITVIEW_NODE=/path/to/node
   ```
3. Start it and read the pairing code from the journal:
   ```sh
   sudo systemctl start gitview-bridge
   journalctl -u gitview-bridge -n 20        # shows the pairing code
   ```
4. In the app, add a bridge pointing at `http://<host>:8787` (front it with
   **Tailscale Serve** — never expose a read/write bridge publicly) and pair.

Manage it like any service: `systemctl {status,restart,stop} gitview-bridge`.

## Claude (chat) support

The `.deb` ships **git browse/edit only** — the two optional `@anthropic-ai/*`
packages are omitted to keep it lean and arch-independent; the bridge degrades
gracefully without them. To enable chat, install them into the package dir and
provide Claude credentials on the host:

```sh
cd /opt/gitview-bridge
sudo npm install --omit=dev @anthropic-ai/claude-agent-sdk @anthropic-ai/sandbox-runtime
sudo systemctl restart gitview-bridge
```

## Uninstall

```sh
sudo apt-get remove gitview-bridge     # stop + disable + remove
sudo apt-get purge  gitview-bridge     # also removes /var/lib/gitview-bridge + the user
```
