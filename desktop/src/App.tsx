import * as Switch from '@radix-ui/react-switch';
import {
  Activity, ArrowRight, ArrowUpRight, Cable, Check, ChevronRight, CircleAlert, Clipboard, Clock3, Copy, Download,
  KeyRound, LayoutDashboard, Link2, ListFilter, LoaderCircle, LockKeyhole, PanelTopClose, Play, Search,
  Settings2, ShieldCheck, Square, Terminal, Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { native } from './native';
import type { ActivityEntry, Check as CheckState, Client, CopyField, Destination, GatewayState, Level, Phase, Settings, Tunnel, UpdateStatus } from './native';

const navigation = [
  { id: 'overview', name: 'Overview', icon: LayoutDashboard, description: 'Start, stop, and check your MCP connection.' },
  { id: 'setup', name: 'Client setup', icon: Cable, description: 'Connect ChatGPT or Gemini to Desktop Commander.' },
  { id: 'activity', name: 'Activity', icon: Activity, description: 'Review tunnel, OAuth, and MCP events.' },
  { id: 'settings', name: 'Settings', icon: Settings2, description: 'Manage the tunnel, updates, and window behavior.' },
] as const;

type Page = typeof navigation[number]['id'];
type Actions = {
  go: (page: Page) => void;
  run: (task: () => Promise<unknown>, success?: string) => void;
  copy: (field: CopyField, label: string) => Promise<boolean>;
  open: (link: Destination) => void;
};

const defaults: Settings = { funnelPort: null, callbackUri: '', closeToTray: true, tunnel: 'tailscale', autoCheckUpdates: true };
const tunnelNames: Record<Tunnel, string> = { tailscale: 'Tailscale Funnel', cloudflare: 'Cloudflare Quick Tunnel' };
const checkLabels: Record<CheckState, string> = { waiting: 'Waiting', passed: 'Passed', failed: 'Failed' };
const initialUpdate: UpdateStatus = { phase: 'idle', version: null, progress: null, message: null };
const phaseLabels: Record<Phase, string> = {
  stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', error: 'Needs attention',
};

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Status({ phase }: { phase: Phase }) {
  return <span className={`status ${phase}`}><span className="dot" />{phaseLabels[phase]}</span>;
}

function CopyButton({ field, label, copy, disabled }: { field: CopyField, label: string, copy: Actions['copy'], disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return <button className="button secondary small" disabled={disabled} type="button" aria-label={`Copy ${label}`} onClick={async () => {
    if (await copy(field, label)) setCopied(true);
  }}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</button>;
}

function Notice({ state, actions }: { state: GatewayState, actions: Actions }) {
  if (!state.message && !state.setupUrl) return null;
  return <div className="notice" role="status">
    <CircleAlert />
    <div>
      <strong>{state.setupUrl ? 'Funnel needs approval' : 'Connection could not start'}</strong>
      <p>{state.setupUrl ? 'Approve Funnel in your browser and start the connection again if prompted.' : state.message}</p>
      {state.setupUrl && <button className="text-button" onClick={() => actions.open('enable')}>Open approval page <ArrowUpRight /></button>}
      {state.message?.includes('sudo tailscale set --operator=') && <button className="text-button" onClick={() => void actions.copy('operator', 'Terminal command')}>Copy terminal command <Copy /></button>}
    </div>
  </div>;
}

function activeTunnel(state: GatewayState) {
  return ['running', 'starting', 'stopping'].includes(state.phase) && state.activeTunnel
    ? state.activeTunnel : state.settings.tunnel;
}

function CheckResult({ status }: { status: CheckState }) {
  return <span className={`check-result ${status}`}><span className="dot" />{checkLabels[status]}</span>;
}

function ConnectionChecks({ state }: { state: GatewayState }) {
  const { https, chatgptOauth, chatgptMcp, geminiOauth, geminiMcp } = state.diagnostics;
  return <section className="panel">
    <div className="panel-heading"><div><h2>Connection checks</h2><p>HTTPS is checked from this computer. Client checks update when each app connects.</p></div><ShieldCheck /></div>
    <div className="checks">
      <div><strong>HTTPS endpoint</strong><CheckResult status={https} /></div>
      <table><thead><tr><th scope="col">Client</th><th scope="col">OAuth exchange</th><th scope="col">MCP session</th></tr></thead>
        <tbody><tr><th scope="row">ChatGPT</th><td><CheckResult status={chatgptOauth} /></td><td><CheckResult status={chatgptMcp} /></td></tr>
          <tr><th scope="row">Gemini</th><td><CheckResult status={geminiOauth} /></td><td><CheckResult status={geminiMcp} /></td></tr></tbody></table>
    </div>
  </section>;
}

function Overview({ state, entries, actions }: { state: GatewayState, entries: ActivityEntry[], actions: Actions }) {
  const [pending, setPending] = useState(false);
  const running = state.phase === 'running';
  const starting = state.phase === 'starting';
  const stopping = state.phase === 'stopping';
  const inProgress = running || starting;
  const tunnel = activeTunnel(state);
  const installed = tunnel === 'cloudflare' ? state.cloudflaredInstalled : state.tailscaleInstalled;
  const buttonLabel = stopping ? 'Stopping…' : running ? 'Stop connection' : starting ? 'Cancel' : 'Start connection';

  async function toggle() {
    if (!installed && !inProgress) {
      actions.go('setup');
      return;
    }
    setPending(true);
    try {
      await (inProgress ? native.stop() : native.start());
    } catch (error) {
      actions.run(() => Promise.reject(error));
    } finally {
      setPending(false);
    }
  }

  return <div className="stack">
    <section className={`connection-panel ${state.phase}`} aria-labelledby="connection-title">
      <div className="connection-top">
        <div className="connection-icon"><Link2 /></div>
        <Status phase={state.phase} />
      </div>
      <div className="connection-heading">
        <div><h2 id="connection-title">MCP connection</h2><p>{tunnelNames[tunnel]}{tunnel === 'cloudflare' ? ' · Temporary public URL' : ''}</p></div>
        <button className={`button ${inProgress ? 'secondary' : 'primary'}`} disabled={pending || stopping} onClick={() => void toggle()}>
          {stopping ? <LoaderCircle className="spin" /> : inProgress ? <Square /> : <Play />}{!installed && !inProgress ? 'Set up tunnel' : buttonLabel}
        </button>
      </div>
      <div className="endpoint">
        <div><span className="field-label">Server URL</span><code>{running && state.url ? state.url : 'Available when the tunnel starts'}</code></div>
        <CopyButton field="url" label="server URL" copy={actions.copy} disabled={!running} />
      </div>
    </section>
    <Notice state={state} actions={actions} />
    <div className="metrics">
      <section className="panel metric"><div className="metric-icon"><ShieldCheck /></div><div><h2>{tunnelNames[tunnel]}</h2><p>{installed ? 'Installed on this computer' : `Install ${tunnel === 'cloudflare' ? 'cloudflared' : 'Tailscale'} to get started`}</p></div><button className="icon-button" aria-label="Open client setup" onClick={() => actions.go('setup')}><ChevronRight /></button></section>
      <section className="panel metric"><div className="metric-icon"><Clock3 /></div><div><h2>Current session</h2><p>{state.startedAt ? `Started at ${clock.format(state.startedAt)}` : 'Connection inactive'}</p></div></section>
    </div>
    <ConnectionChecks state={state} />
    <section className="panel recent">
      <div className="panel-heading"><div><h2>Recent activity</h2><p>Connection and server events</p></div><button className="text-button" onClick={() => actions.go('activity')}>View all <ArrowRight /></button></div>
      <LogRows entries={entries.slice(-4).reverse()} empty="Start a connection to see activity here." />
    </section>
  </div>;
}

function Setup({ state, actions }: { state: GatewayState, actions: Actions }) {
  const [provider, setProvider] = useState<Client>('chatgpt');
  const [confirm, setConfirm] = useState(false);
  const gemini = provider === 'gemini';
  const name = gemini ? 'Gemini' : 'ChatGPT';
  const running = state.phase === 'running';
  const quick = activeTunnel(state) === 'cloudflare';
  const installed = quick ? state.cloudflaredInstalled : state.tailscaleInstalled;
  const credentials: { field: CopyField, label: string, value: string }[] = [
    { field: 'url', label: 'Server URL', value: state.url ?? 'Available after startup' },
    { field: gemini ? 'geminiClientId' : 'clientId', label: 'OAuth client ID', value: (gemini ? state.geminiClientId : state.clientId) ?? 'Available after startup' },
    { field: gemini ? 'geminiClientSecret' : 'clientSecret', label: 'OAuth client secret', value: '••••••••••••' },
    { field: gemini ? 'geminiLoginPassword' : 'loginPassword', label: 'Login password', value: '••••••••••••' },
  ];

  return <div className="stack">
    <Notice state={state} actions={actions} />
    <div className="client-choice" role="group" aria-label="Client to connect">
      <button type="button" aria-pressed={!gemini} onClick={() => { setProvider('chatgpt'); setConfirm(false); }}>ChatGPT</button>
      <button type="button" aria-pressed={gemini} onClick={() => { setProvider('gemini'); setConfirm(false); }}>Gemini</button>
    </div>
    <div className="setup-grid">
      <div className="stack">
        <section className="panel step"><span className="step-index">1</span><div>
          <h2>{quick ? 'Install cloudflared' : 'Install and sign in to Tailscale'}</h2>
          <p>{quick ? 'Start the connection from Overview. Each new Quick Tunnel URL needs a new client link.' : 'Sign in on the computer you want to control, then start the MCP connection from Overview.'}</p>
          <div className="row-actions">
            <button className="text-button" onClick={() => actions.open(quick ? 'cloudflared' : 'tailscale')}>Get {quick ? 'cloudflared' : 'Tailscale'} <ArrowUpRight /></button>
            {installed ? <span className="confirmed"><Check /> Installed</span> : <button className="text-button" onClick={() => actions.run(native.state)}>Check again</button>}
          </div>
        </div></section>
        <section className="panel step"><span className="step-index">2</span><div>
          <h2>Add the server in {name}</h2>
          {gemini
            ? <p>Open <strong>Settings → Connected Apps → Custom apps</strong>. Enter the server URL, then use <strong>Advanced features → Show more</strong> to enter the client ID and secret.</p>
            : <p>Open <strong>Plugins → Add custom MCP server</strong>. Paste the server URL, choose <strong>OAuth</strong>, and enter the client ID and secret.</p>}
          <button className="text-button" onClick={() => actions.open(provider)}>Open {name} <ArrowUpRight /></button>
        </div></section>
        <section className="panel step"><span className="step-index">3</span><div>
          <h2>Authorize the connection</h2><p>When Desktop Commander opens in your browser, paste the login password and select <strong>Authorize</strong>.</p>
        </div></section>
      </div>
      <section className="panel credentials">
        <div className="panel-heading"><div className="icon-heading"><div className="metric-icon"><KeyRound /></div><div><h2>Connection values</h2><p>Copy into the matching {name} fields.</p></div></div></div>
        {credentials.map(({ field, label, value }) => <div className="credential" key={field}>
          <div><span className="field-label">{label}</span><code>{running ? value : 'Available after startup'}</code></div>
          <CopyButton field={field} label={label} copy={actions.copy} disabled={!running} />
        </div>)}
        {!running && <div className="credential-footer"><button className="text-button" onClick={() => actions.go('overview')}>Go to connection controls <ArrowRight /></button></div>}
        <div className="credential-hint"><LockKeyhole /> Keep the client secret and login password private.</div>
        {running && <div className="credential-footer revoke-actions">
          {confirm ? <><p>This ends {name} sessions and invalidates its tokens. You can link it again with the same credentials.</p><div className="row-actions">
            <button className="button secondary small" type="button" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="button secondary small" type="button" onClick={() => { actions.run(() => native.revoke(provider)); setConfirm(false); }}>Revoke {name} access</button>
          </div></> : <button className="text-button" type="button" onClick={() => setConfirm(true)}>Revoke {name} access</button>}
        </div>}
      </section>
    </div>
  </div>;
}

function LogRows({ entries, empty }: { entries: ActivityEntry[], empty: string }) {
  if (!entries.length) return <div className="empty"><Activity /><p>{empty}</p></div>;
  return <ul className="logs" aria-label="Activity entries">{entries.map(entry => <li key={entry.id}>
    <time dateTime={new Date(entry.timestamp).toISOString()} title={new Date(entry.timestamp).toLocaleString()}>{clock.format(entry.timestamp)}</time>
    <span className={`level ${entry.level}`}>{entry.level}</span>
    <span className="log-source">{entry.source}</span>
    <span className="log-message">{entry.message}</span>
  </li>)}</ul>;
}

function ActivityPage({ entries, actions }: { entries: ActivityEntry[], actions: Actions }) {
  const [filter, setFilter] = useState<Level | ''>('');
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const visible = entries.filter(entry => (!filter || entry.level === filter) && `${entry.source} ${entry.message}`.toLowerCase().includes(term)).reverse();
  return <section className="panel activity-panel">
    <div className="panel-heading"><div><h2>Session log</h2><p>{visible.length} {visible.length === 1 ? 'entry' : 'entries'}</p></div><div className="row-actions log-actions">
      <button className="button secondary small" disabled={!entries.length} onClick={() => void actions.copy('activity', 'Redacted activity log')}><Clipboard />Copy redacted log</button>
      <button className="button quiet small" disabled={!entries.length} onClick={() => actions.run(native.clearActivity, 'Activity cleared')}><Trash2 />Clear</button>
    </div></div>
    <div className="log-filters">
      <label className="input-wrap"><Search /><input type="search" aria-label="Search activity" placeholder="Search activity" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="input-wrap"><ListFilter /><select aria-label="Log level" value={filter} onChange={event => setFilter(event.target.value as Level | '')}>
        <option value="">All levels</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option>
      </select></label>
    </div>
    <LogRows entries={visible} empty={entries.length ? 'No activity matches this filter.' : 'Start a connection to collect activity.'} />
  </section>;
}

function UpdatePanel({ version, status, actions }: { version: string; status: UpdateStatus; actions: Actions }) {
  const downloading = status.phase === 'downloading';
  const ready = status.phase === 'ready';
  const message = status.message ?? {
    idle: 'Check GitHub Releases for a signed update.',
    checking: 'Checking for updates…',
    current: 'You’re up to date.',
    available: `Version ${status.version} is available. Install it the next time you quit.`,
    downloading: status.progress === null ? 'Downloading the signed update…' : `Downloading the signed update… ${status.progress}%`,
    ready: `Version ${status.version} is ready to install when you quit.`,
    error: 'Update check failed.',
  }[status.phase];

  return <section className="panel preferences" aria-label="About and updates">
    <div className="panel-heading"><div><h2>About and updates</h2><p>Desktop Commander Connect v{version}</p></div><Download /></div>
    <div className="update-controls">
      <p role="status">{message}</p>
      {downloading && <progress aria-label="Update download" max={100} value={status.progress ?? undefined} />}
      <div className="row-actions">
        {status.phase === 'available' && <button className="button primary small" type="button" onClick={() => actions.run(native.downloadUpdate)}>Download update</button>}
        {ready && <><button className="button primary small" type="button" onClick={() => actions.run(native.quit)}>Quit and install</button><button className="button quiet small" type="button" onClick={() => actions.run(native.cancelUpdate)}>Cancel update</button></>}
        {!ready && !downloading && <button className="button secondary small" type="button" disabled={status.phase === 'checking'} onClick={() => actions.run(native.checkUpdates)}>Check for updates</button>}
        <button className="text-button" type="button" onClick={() => actions.open('releases')}>GitHub Releases <ArrowUpRight /></button>
      </div>
    </div>
  </section>;
}

function SettingsPage({ state, update, actions }: { state: GatewayState; update: UpdateStatus; actions: Actions }) {
  const [draft, setDraft] = useState(state.settings);
  const dirty = (Object.keys(draft) as (keyof Settings)[]).some(key => draft[key] !== state.settings[key]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.run(async () => setDraft(await native.save(draft)), 'Settings saved');
  }

  return <form className="stack" onSubmit={save}>
    <section className="panel preferences">
      <div className="panel-heading"><div><h2>Connection</h2><p>Changes apply the next time you start the connection.</p></div><ShieldCheck /></div>
      <div className="form-row"><div><label htmlFor="tunnel">Public tunnel</label><p>{draft.tunnel === 'cloudflare' ? 'Every start creates a fresh URL. Connect your clients again when it changes.' : 'Tailscale gives your clients a stable URL while the hostname and port stay the same.'}</p></div>
        <select id="tunnel" value={draft.tunnel} onChange={event => setDraft({ ...draft, tunnel: event.target.value as Tunnel })}>
          <option value="tailscale">Tailscale Funnel</option><option value="cloudflare">Cloudflare Quick Tunnel</option>
        </select>
      </div>
      {draft.tunnel === 'tailscale' && <div className="form-row"><div><label htmlFor="port">Public Funnel port</label><p>Automatic selects the first free port.</p></div>
        <select id="port" value={draft.funnelPort ?? ''} onChange={event => setDraft({ ...draft, funnelPort: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Automatic</option><option value="443">443</option><option value="8443">8443</option><option value="10000">10000</option>
        </select>
      </div>}
      <div className="form-row callback"><div><label htmlFor="callback">ChatGPT callback URL <span>Optional</span></label><p>Enter the exact callback URL only if ChatGPT provides a custom one.</p></div>
        <input id="callback" type="url" spellCheck={false} placeholder="https://chatgpt.com/connector/oauth/…" value={draft.callbackUri} onChange={event => setDraft({ ...draft, callbackUri: event.target.value })} />
      </div>
    </section>
    <UpdatePanel version={state.version} status={update} actions={actions} />
    <section className="panel preferences">
      <div className="form-row"><div><label htmlFor="auto-updates">Check for updates at startup</label><p>Install an available update when you choose to quit.</p></div>
        <Switch.Root id="auto-updates" className="switch" checked={draft.autoCheckUpdates} onCheckedChange={autoCheckUpdates => setDraft({ ...draft, autoCheckUpdates })}><Switch.Thumb className="switch-thumb" /></Switch.Root>
      </div>
    </section>
    <section className="panel preferences">
      <div className="panel-heading"><div><h2>Window</h2><p>Choose what happens when you close the window.</p></div><PanelTopClose /></div>
      <div className="form-row"><div><label htmlFor="tray">Keep running in the tray</label><p>{state.canHide ? 'The tray menu can reopen the window or quit the app.' : 'The system tray is unavailable in this desktop session.'}</p></div>
        <Switch.Root id="tray" className="switch" checked={draft.closeToTray} disabled={!state.canHide} onCheckedChange={closeToTray => setDraft({ ...draft, closeToTray })}><Switch.Thumb className="switch-thumb" /></Switch.Root>
      </div>
    </section>
    <div className="save-bar"><button className="button quiet" type="button" onClick={() => setDraft({ ...defaults })}>Restore defaults</button><button className="button primary" type="submit" disabled={!dirty}>Save changes</button></div>
  </form>;
}

export function App() {
  const [update, setUpdate] = useState(initialUpdate);
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<GatewayState>();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [toast, setToast] = useState<{ message: string, error: boolean }>();
  const cleared = useRef(0);
  const toastTimeout = useRef<number>(undefined);

  function announce(message: string, error = false) {
    window.clearTimeout(toastTimeout.current);
    setToast({ message, error });
    toastTimeout.current = window.setTimeout(() => setToast(undefined), error ? 5700 : 2700);
  }

  useEffect(() => {
    let active = true;
    function merge(incoming: ActivityEntry[]) {
      if (!active) return;
      setEntries(current => [...new Map([...current, ...incoming].map(entry => [entry.id, entry])).values()]
        .filter(entry => entry.id > cleared.current).sort((left, right) => left.id - right.id).slice(-300));
    }

    let receivedUpdate = false;
    const subscriptions = Promise.all([
      native.onState(next => { if (active) setState(next); }),
      native.onUpdate(next => {
        receivedUpdate = true;
        if (active) setUpdate(next);
      }),
      native.onActivity(entry => merge([entry])),
      native.onClear(id => {
        cleared.current = Math.max(cleared.current, id);
        if (active) setEntries(current => current.filter(entry => entry.id > cleared.current));
      }),
    ]);
    void subscriptions.then(async () => {
      const [initial, history, initialStatus] = await Promise.all([native.state(), native.activity(), native.update()]);
      if (active) {
        setState(current => current ?? initial);
        if (!receivedUpdate) setUpdate(initialStatus);
      }
      merge(history);
    }).catch(error => { if (active) announce(String(error), true); });
    return () => {
      active = false;
      window.clearTimeout(toastTimeout.current);
      void subscriptions.then(cleanups => cleanups.forEach(unlisten => unlisten())).catch(() => {});
    };
  }, []);

  const actions: Actions = {
    go: setPage,
    run(task, success) {
      void task().then(() => { if (success) announce(success); }).catch(error => announce(String(error), true));
    },
    async copy(field, label) {
      try {
        await native.copy(field);
        announce(`${label} copied`);
        return true;
      } catch (error) {
        announce(String(error), true);
        return false;
      }
    },
    open: link => actions.run(() => native.open(link)),
  };

  const selected = navigation.find(item => item.id === page)!;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Terminal /></span><div><strong>Desktop Commander</strong><span>Connect{state?.version ? ` · v${state.version}` : ''}</span></div></div>
      <nav aria-label="Main navigation">{navigation.map(({ id, icon: Icon, name }) => <button key={id} type="button" aria-label={name} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon /><span>{name}</span></button>)}</nav>
      <div className="sidebar-footer">
        <Status phase={state?.phase ?? 'stopped'} />
        {(update.phase === 'available' || update.phase === 'ready') && <button className="button quiet" type="button" aria-label="View update" onClick={() => setPage('settings')}><Download /><span>{update.phase === 'ready' ? 'Update ready' : 'Update available'}</span></button>}
        <button className="button quiet" type="button" aria-label={state?.canHide ? 'Hide to tray' : 'Minimize'} onClick={() => actions.run(native.hide)}><PanelTopClose /><span>{state?.canHide ? 'Hide to tray' : 'Minimize'}</span></button>
      </div>
    </aside>
    <main>
      <header className="page-header"><h1>{selected.name}</h1><p>{selected.description}</p></header>
      {!state ? <div className="panel empty"><LoaderCircle className="spin" /><p>Loading Desktop Commander…</p></div> : <>
        {page === 'overview' && <Overview state={state} entries={entries} actions={actions} />}
        {page === 'setup' && <Setup state={state} actions={actions} />}
        {page === 'activity' && <ActivityPage entries={entries} actions={actions} />}
        {page === 'settings' && <SettingsPage state={state} update={update} actions={actions} />}
      </>}
    </main>
    {toast && <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <CircleAlert /> : <Check />}<span>{toast.message}</span></div>}
  </div>;
}
