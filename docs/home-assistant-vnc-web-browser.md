# Home Assistant OS: VNC Web Browser

This guide connects the Stagehand node to Chromium in the [MindFreeze VNC Web Browser add-on](https://github.com/MindFreeze/ha-vnc-web-browser). The add-on runs Chromium in a separate container from n8n, so Stagehand's extension must be installed in that Chromium container before the node can run Stagehand operations.

CDP is a remote-control protocol, not a shared filesystem. If Stagehand asks Chromium to load an extension from a path, Chromium resolves that path inside the browser's container. A path that exists only in n8n cannot be loaded by the Home Assistant browser.

This requirement changed with Stagehand v4, which moved the runtime into a browser extension. The earlier node version used a Stagehand 2.4.2 hotfix, whose runtime did not require this v4 extension setup. See the [Stagehand v4 architecture announcement](https://www.browserbase.com/blog/stagehand-v4).

## Before you start

- Stagehand 4.4.0 is installed with the n8n node. This guide's extension export command uses the same version.
- Node.js 22.18 or newer and npm are available on your computer to create the extension archive locally.
- The VNC Web Browser add-on has a display configured with a `cdp_port` (9221–9224).
- The CDP port is reachable from n8n on a trusted network. CDP has no authentication; do not expose it to the internet or an untrusted network.
- Home Assistant's Samba share app is running so you can copy files to its `share` folder.

## Prepare the Home Assistant terminal

Install the community [Advanced SSH & Web Terminal app](https://github.com/hassio-addons/repository/tree/master/ssh) from **Settings → Apps → Install app**. This is different from Home Assistant's official Terminal & SSH app, which does not provide host filesystem access. On the Advanced app's **Info** page, temporarily turn **Protection mode** off and restart the app so its terminal can access Docker. This gives the app broad host access; turn Protection mode back on and restart it after step 3.

## 1. Create the matching Stagehand extension archive

On your computer, create a temporary folder and install the same Stagehand version used by the n8n node:

```sh
mkdir stagehand-extension-export
cd stagehand-extension-export
npm init -y
npm install @browserbasehq/stagehand@4.4.0
node --input-type=module -e "import { writeFile } from 'node:fs/promises'; import { getExtensionArchive } from '@browserbasehq/stagehand'; await writeFile('stagehand-extension.zip', await getExtensionArchive())"
```

The command writes `stagehand-extension.zip` to the temporary folder on your computer. If the n8n node uses a different Stagehand version, substitute that version in the `npm install` command.

## 2. Copy the extension into Home Assistant's share

On Windows, extract the ZIP so you have a folder named `stagehand-extension` containing `manifest.json` directly inside it. Use the Home Assistant Samba share app to copy that folder into the `share` folder. In File Explorer, open `\\<Home-Assistant-IP>\share`, using the same IP address as your Home Assistant web page. Home Assistant's [file access guide](https://www.home-assistant.io/common-tasks/os/) explains how to install and configure Samba share.

## 3. Copy the folder into the VNC add-on container

Open the Advanced SSH & Web Terminal app's web terminal. Find the VNC add-on container name:

```sh
docker ps --format '{{.Names}} {{.Image}}'
```

Set `VNC_CONTAINER` to the VNC Web Browser container name shown by the previous command:

```sh
VNC_CONTAINER='replace-with-vnc-container-name'
docker exec "$VNC_CONTAINER" mkdir -p /data/stagehand-extension
docker cp /share/stagehand-extension/. "$VNC_CONTAINER":/data/stagehand-extension/
docker exec "$VNC_CONTAINER" test -f /data/stagehand-extension/manifest.json
```

The last command should finish without an error. `/data` is persistent storage for the add-on.

After the copy succeeds, turn Protection mode back on for the Advanced SSH & Web Terminal app and restart it.

## 4. Load the extension when Chromium starts

In the VNC Web Browser add-on configuration, append these arguments to the target display's existing `browser_args`:

```text
--enable-unsafe-extension-debugging --load-extension=/data/stagehand-extension
```

Save the configuration and restart the add-on. Keep its `cdp_port` enabled. Configure the Stagehand node with the corresponding CDP WebSocket URL, connect an n8n Chat Model, and run the operation.

## Troubleshooting

- **`File path cannot be resolved`**: Chromium could not find an extension path visible inside the VNC container. Repeat step 3 and confirm `manifest.json` is directly under `/data/stagehand-extension`.
- **`domSettleTimeoutMs` must be greater than zero**: update the n8n community node to version 1.8.0 or later.
- **CDP connection fails**: check the add-on's configured `cdp_port`, network reachability from n8n, and that the port is not blocked by the host or container network.
