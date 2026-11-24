import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type Phase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type Level = 'info' | 'warning' | 'error';
export type Tunnel = 'tailscale' | 'cloudflare';
export type Client = 'chatgpt' | 'gemini';
export type Check = 'waiting' | 'passed' | 'failed';

export interface Settings {
  funnelPort: number | null;
  callbackUri: string;
  closeToTray: boolean;
  tunnel: Tunnel;
  autoCheckUpdates: boolean;
}

export interface GatewayState {
  phase: Phase;
  tailscaleInstalled: boolean;
  cloudflaredInstalled: boolean;
  version: string;
  activeTunnel: Tunnel | null;
  diagnostics: { https: Check; chatgptOauth: Check; chatgptMcp: Check; geminiOauth: Check; geminiMcp: Check };
  canHide: boolean;
  url: string | null;
  clientId: string | null;
  geminiClientId: string | null;
  setupUrl: string | null;
  message: string | null;
  startedAt: number | null;
  settings: Settings;
}

export interface ActivityEntry {
  id: number;
  timestamp: number;
  level: Level;
  source: string;
  message: string;
}

export type CopyField = 'url' | 'clientId' | 'clientSecret' | 'loginPassword' |
  'geminiClientId' | 'geminiClientSecret' | 'geminiLoginPassword' | 'activity' | 'operator';
export type Destination = 'tailscale' | 'funnel' | 'chatgpt' | 'gemini' | 'enable' | 'cloudflared' | 'releases';

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  progress: number | null;
  message: string | null;
}

export const native = {
  state: () => invoke<GatewayState>('gateway_state'),
  activity: () => invoke<ActivityEntry[]>('gateway_activity'),
  start: () => invoke<void>('start_gateway'),
  stop: () => invoke<void>('stop_gateway'),
  quit: () => invoke<void>('quit_app'),
  revoke: (provider: Client) => invoke<void>('revoke_client', { provider }),
  save: (settings: Settings) => invoke<Settings>('update_settings', { settings }),
  clearActivity: () => invoke<void>('clear_activity'),
  copy: (field: CopyField) => invoke<void>('copy_value', { field }),
  open: (link: Destination) => invoke<void>('open_link', { link }),
  hide: () => invoke<void>('hide_window'),
  update: () => invoke<UpdateStatus>('update_status'),
  checkUpdates: () => invoke<void>('check_updates'),
  downloadUpdate: () => invoke<void>('download_update'),
  cancelUpdate: () => invoke<void>('cancel_update'),
  onUpdate: (fn: (value: UpdateStatus) => void) => listen<UpdateStatus>('update-status', event => fn(event.payload)),
  onState: (fn: (value: GatewayState) => void) => listen<GatewayState>('gateway-state', event => fn(event.payload)),
  onActivity: (fn: (value: ActivityEntry) => void) => listen<ActivityEntry>('gateway-activity', event => fn(event.payload)),
  onClear: (fn: (id: number) => void) => listen<number>('gateway-activity-cleared', event => fn(event.payload)),
};
