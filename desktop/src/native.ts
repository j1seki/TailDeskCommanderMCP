import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type Phase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type Level = 'info' | 'warning' | 'error';

export interface Settings {
  funnelPort: number | null;
  callbackUri: string;
  closeToTray: boolean;
}

export interface GatewayState {
  phase: Phase;
  tailscaleInstalled: boolean;
  canHide: boolean;
  url: string | null;
  clientId: string | null;
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

export type CopyField = 'url' | 'clientId' | 'clientSecret' | 'loginPassword' | 'activity' | 'operator';
export type Destination = 'tailscale' | 'funnel' | 'chatgpt' | 'enable';

export const native = {
  state: () => invoke<GatewayState>('gateway_state'),
  activity: () => invoke<ActivityEntry[]>('gateway_activity'),
  start: () => invoke<void>('start_gateway'),
  stop: () => invoke<void>('stop_gateway'),
  save: (settings: Settings) => invoke<Settings>('update_settings', { settings }),
  clearActivity: () => invoke<void>('clear_activity'),
  copy: (field: CopyField) => invoke<void>('copy_value', { field }),
  open: (link: Destination) => invoke<void>('open_link', { link }),
  hide: () => invoke<void>('hide_window'),
  onState: (fn: (value: GatewayState) => void) => listen<GatewayState>('gateway-state', event => fn(event.payload)),
  onActivity: (fn: (value: ActivityEntry) => void) => listen<ActivityEntry>('gateway-activity', event => fn(event.payload)),
  onClear: (fn: (id: number) => void) => listen<number>('gateway-activity-cleared', event => fn(event.payload)),
};
