# Desktop Commander Connect

The Rust and TypeScript app packages Desktop Commander, Node, the OAuth gateway, and ripgrep. On first use it unpacks those files into your local app data. Install Tailscale or cloudflared separately.

Download the portable app for your platform from GitHub Releases. [Desktop downloads and checksums](../README.md#download-desktop-commander-connect)

## Set up ChatGPT or Gemini

1. Choose a tunnel in **Settings**. Tailscale Funnel provides a stable URL once signed in and enabled. Cloudflare Quick Tunnel uses the installed `cloudflared` executable and assigns a new URL on every start. [Tailscale Funnel setup](https://tailscale.com/docs/features/tailscale-funnel#enable-funnel) · [cloudflared downloads](https://developers.cloudflare.com/tunnel/downloads/)
2. Open **Overview** and choose **Start connection**. If Tailscale prompts you, approve Funnel for this device and retry. Linux may require granting your account Tailscale operator permission once. The app shows a copyable terminal command when needed.
3. Open **Client setup**, select your client, and use the copy buttons to enter that client's values.
   - **ChatGPT** — Open **Plugins → Add custom MCP server** and paste the **Server URL**. Select **OAuth**, then enter the **OAuth client ID** and **OAuth client secret**. [ChatGPT setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
   - **Gemini** — In the Gemini web app, open **Settings → Connected Apps → Custom apps** and enter the **Server URL**. Under **Advanced features → Show more**, enter the Gemini **OAuth client ID** and **OAuth client secret**. [Gemini eligibility and setup](https://support.google.com/gemini/answer/17209137)
4. When the Desktop Commander sign-in page opens, paste the **Login password** for the selected client and select **Authorize**.

You can use ChatGPT or Gemini on another device while the app runs on the computer it controls. **Hide to tray** keeps the connection active. Open the app again or stop the connection from the tray menu. **Quit** shuts down the server and its tunnel. Tray availability on Linux depends on desktop support for AppIndicator.

**Overview** shows the HTTPS check from your computer and each client's last OAuth exchange and MCP initialization. **Activity → Copy redacted log** removes URLs and secret-shaped values from the exported session log. **Client setup → Revoke access** ends sessions and invalidates tokens for the selected client. Its login values can be used to link again. Connection preferences apply on the next start.

An existing ChatGPT connection can keep using its saved credentials after upgrading. Use the same public Funnel URL. Gemini has its own credentials and uses the same server URL.

If you used the shell launcher earlier, stop it before starting the desktop app to reuse its available Funnel port. On macOS and Linux the app uses the same default OAuth credentials as the shell launcher. On Windows it saves OAuth credentials under `%LOCALAPPDATA%\desktop-commander`.

## Install updates

**Settings → About and updates** shows the current version. The app checks GitHub Releases at startup when automatic checking is enabled. Download a signed update and quit the app to install it. The executable or app bundle must be in a writable location. This also works with the portable Windows executable. Users upgrading from v0.3.6 download the first update-enabled version from Releases. [Latest desktop release](https://github.com/j1seki/TailDeskCommanderMCP/releases/latest)

## Build portable packages

The **TailDeskCommanderMCP packages** GitHub Actions workflow tests and builds the portable app for each supported platform. The macOS build is ad hoc signed. Distribution to other users through Gatekeeper requires a Developer ID signature and notarization. [Package workflow](https://github.com/j1seki/TailDeskCommanderMCP/actions/workflows/desktop-connect.yml)

On a development machine, install Node 22.12 or later, Rust, and the Tauri build prerequisites for that OS. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
npm ci --include=dev --ignore-scripts
npm run build
npm --prefix desktop ci
npm --prefix desktop run prepare-runtime
```

| Platform | Run on the target OS |
| --- | --- |
| Windows | `npm --prefix desktop run tauri build -- --no-bundle` |
| macOS | `npm --prefix desktop run tauri build -- --bundles app` |
| Linux | `npm --prefix desktop run tauri build -- --bundles appimage` |

Artifacts are under `desktop/src-tauri/target/release`. Windows uses the system WebView2 runtime. The macOS app requires macOS 13.5 or later. The AppImage requires a compatible Linux distribution and a desktop session.

## Publish a desktop release

Keep the version in `desktop/package.json` and `desktop/src-tauri/Cargo.toml` in sync with their lockfiles. Tauri and the versioned asset names read the npm package version. A `desktop-v<VERSION>` tag triggers the five platform builds and publishes their signed update assets, `latest.json`, and `SHA256SUMS` after the checks pass.

The workflow signs with the `TAILDESK_DESKTOP_SIGNING_KEY` repository secret and uses `TAILDESK_DESKTOP_SIGNING_PASSWORD` when the key has a password. Keep a private backup of the key. The matching public key is pinned in `src-tauri/tauri.conf.json`, and the updater verifies both the asset and its signed version.
