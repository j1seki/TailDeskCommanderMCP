# Desktop Commander Connect

The Rust and TypeScript app packages Desktop Commander, Node, the OAuth gateway, and ripgrep inside the application. On first use it unpacks those files into your local app data. Tailscale remains a separate install. The app uses your computer's signed-in Tailscale client and its Funnel permission.

## Set up ChatGPT

1. Install Tailscale on the computer you want to control and sign in there. [Tailscale downloads](https://tailscale.com/download)
2. Start Desktop Commander Connect and choose **Start connection**. If prompted, approve Funnel for this device and retry. Linux may require granting your account Tailscale operator permission once. The app shows a copyable terminal command when this is needed. [Tailscale Funnel setup](https://tailscale.com/docs/features/tailscale-funnel#enable-funnel)
3. In ChatGPT, open **Plugins → Add custom MCP server** and paste the **Server URL**. Select **OAuth**, then copy the **OAuth client ID** and **OAuth client secret** into the corresponding fields. [ChatGPT setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
4. When the Desktop Commander sign-in page opens, paste the **Login password** and select **Authorize**.

You can use ChatGPT on another device while the app runs on the computer it controls. **Hide to tray** keeps the connection active. Open the app again or stop the connection from the tray menu. **Quit** shuts down the server and its foreground Funnel route. Tray availability on Linux depends on desktop support for AppIndicator.

Use **Overview** to start and stop the endpoint, **ChatGPT setup** for the steps and copy buttons, and **Activity** to search, filter, or copy recent connection logs. Activity keeps a rolling history for the current app session. **Settings** saves your preferred public Funnel port, a custom ChatGPT callback URL if one is required, and whether closing the window hides it in the tray. Connection preferences apply on the next start.

If you used the shell launcher earlier, stop it before starting the desktop app to reuse its available Funnel port. On macOS and Linux the app uses the same default OAuth credentials as the shell launcher. On Windows it saves OAuth credentials under `%LOCALAPPDATA%\desktop-commander`.

## Build portable packages

The **TailDeskCommanderMCP packages** GitHub Actions workflow builds Windows x64 `.exe`, macOS Apple Silicon and Intel `.app` archives, and Linux x64 and ARM64 AppImages. The macOS build is ad hoc signed. Distribution to other users through Gatekeeper requires a Developer ID signature and notarization. [Download build artifacts](https://github.com/j1seki/TailDeskCommanderMCP/actions/workflows/desktop-connect.yml?query=branch%3Amain+is%3Asuccess)

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
