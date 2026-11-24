import * as Switch from '@radix-ui/react-switch';
import {
  Activity, ArrowRight, ArrowUpRight, Cable, Check, ChevronRight, CircleAlert, Clipboard, Clock3, Copy,
  KeyRound, LayoutDashboard, Link2, ListFilter, LoaderCircle, LockKeyhole, PanelTopClose, Play, Search,
  Settings2, ShieldCheck, Square, Terminal, Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { native } from './native';
import type { ActivityEntry, CopyField, Destination, GatewayState, Level, Phase, Settings } from './native';

const navigation = [
  { id: 'overview', name: 'Overview', icon: LayoutDashboard, description: 'Start, stop, and check your MCP connection.' },
  { id: 'setup', name: 'Client setup', icon: Cable, description: 'Connect ChatGPT or Gemini to Desktop Commander.' },
  { id: 'activity', name: 'Activity', icon: Activity, description: 'Review connection, runtime, and Tailscale events.' },
  { id: 'settings', name: 'Settings', icon: Settings2, description: 'Manage connection preferences and window behavior.' },
] as const;

type Page = typeof navigation[number]['id'];
type Actions = {
  go: (page: Page) => void;
  run: (task: () => Promise<unknown>, success?: string) => void;
  copy: (field: CopyField, label: string) => Promise<boolean>;
  open: (link: Destination) => void;
};

const defaults: Settings = { funnelPort: null, callbackUri: '', closeToTray: true };
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

function Overview({ state, entries, actions }: { state: GatewayState, entries: ActivityEntry[], actions: Actions }) {
  const [pending, setPending] = useState(false);
  const running = state.phase === 'running';
  const starting = state.phase === 'starting';
  const stopping = state.phase === 'stopping';
  const inProgress = running || starting;
  const buttonLabel = stopping ? 'Stopping…' : running ? 'Stop connection' : starting ? 'Cancel' : 'Start connection';

  async function toggle() {
    if (!state.tailscaleInstalled && !inProgress) {
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
        <div><h2 id="connection-title">MCP connection</h2><p>{running ? 'ChatGPT and Gemini can reach this computer through Tailscale Funnel.' : 'Publish the local MCP server through Tailscale Funnel.'}</p></div>
        <button className={`button ${inProgress ? 'secondary' : 'primary'}`} disabled={pending || stopping} onClick={() => void toggle()}>
          {stopping ? <LoaderCircle className="spin" /> : inProgress ? <Square /> : <Play />}{!state.tailscaleInstalled && !inProgress ? 'Set up Tailscale' : buttonLabel}
        </button>
      </div>
      <div className="endpoint">
        <div><span className="field-label">Server URL</span><code>{running && state.url ? state.url : 'Available when Funnel starts'}</code></div>
        <CopyButton field="url" label="server URL" copy={actions.copy} disabled={!running} />
      </div>
    </section>
    <Notice state={state} actions={actions} />
    <div className="metrics">
      <section className="panel metric"><div className="metric-icon"><ShieldCheck /></div><div><h2>Tailscale</h2><p>{state.tailscaleInstalled ? 'Installed on this computer' : 'Install Tailscale to get started'}</p></div><button className="icon-button" aria-label="Open client setup" onClick={() => actions.go('setup')}><ChevronRight /></button></section>
      <section className="panel metric"><div className="metric-icon"><Clock3 /></div><div><h2>Current session</h2><p>{state.startedAt ? `Started at ${clock.format(state.startedAt)}` : 'Connection inactive'}</p></div></section>
    </div>
    <section className="panel recent">
      <div className="panel-heading"><div><h2>Recent activity</h2><p>Connection and server events</p></div><button className="text-button" onClick={() => actions.go('activity')}>View all <ArrowRight /></button></div>
      <LogRows entries={entries.slice(-4).reverse()} empty="Start a connection to see activity here." />
    </section>
  </div>;
}

function Setup({ state, actions }: { state: GatewayState, actions: Actions }) {
  const [provider, setProvider] = useState<'chatgpt' | 'gemini'>('chatgpt');
  const gemini = provider === 'gemini';
  const name = gemini ? 'Gemini' : 'ChatGPT';
  const running = state.phase === 'running';
  const credentials: { field: CopyField, label: string, value: string }[] = [
    { field: 'url', label: 'Server URL', value: state.url ?? 'Available after startup' },
    { field: gemini ? 'geminiClientId' : 'clientId', label: 'OAuth client ID', value: (gemini ? state.geminiClientId : state.clientId) ?? 'Available after startup' },
    { field: gemini ? 'geminiClientSecret' : 'clientSecret', label: 'OAuth client secret', value: '••••••••••••' },
    { field: gemini ? 'geminiLoginPassword' : 'loginPassword', label: 'Login password', value: '••••••••••••' },
  ];

  return <div className="stack">
    <Notice state={state} actions={actions} />
    <div className="client-choice" role="group" aria-label="Client to connect">
      <button type="button" aria-pressed={!gemini} onClick={() => setProvider('chatgpt')}>ChatGPT</button>
      <button type="button" aria-pressed={gemini} onClick={() => setProvider('gemini')}>Gemini</button>
    </div>
    <div className="setup-grid">
      <div className="stack">
        <section className="panel step"><span className="step-index">1</span><div>
          <h2>Install and sign in to Tailscale</h2><p>Sign in on the computer you want to control, then start the MCP connection from Overview.</p>
          <div className="row-actions">
            <button className="text-button" onClick={() => actions.open('tailscale')}>Get Tailscale <ArrowUpRight /></button>
            {state.tailscaleInstalled ? <span className="confirmed"><Check /> Installed</span> : <button className="text-button" onClick={() => actions.run(native.state)}>Check again</button>}
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
      <button className="button secondary small" disabled={!entries.length} onClick={() => void actions.copy('activity', 'Activity log')}><Clipboard />Copy all</button>
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

function SettingsPage({ state, actions }: { state: GatewayState, actions: Actions }) {
  const [draft, setDraft] = useState(state.settings);
  const dirty = draft.funnelPort !== state.settings.funnelPort || draft.callbackUri !== state.settings.callbackUri || draft.closeToTray !== state.settings.closeToTray;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.run(async () => setDraft(await native.save(draft)), 'Settings saved');
  }

  return <form className="stack" onSubmit={save}>
    <section className="panel preferences">
      <div className="panel-heading"><div><h2>Connection</h2><p>Changes apply the next time you start the connection.</p></div><ShieldCheck /></div>
      <div className="form-row"><div><label htmlFor="port">Public Funnel port</label><p>Automatic selects the first free port.</p></div>
        <select id="port" value={draft.funnelPort ?? ''} onChange={event => setDraft({ ...draft, funnelPort: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Automatic</option><option value="443">443</option><option value="8443">8443</option><option value="10000">10000</option>
        </select>
      </div>
      <div className="form-row callback"><div><label htmlFor="callback">ChatGPT callback URL <span>Optional</span></label><p>Enter the exact callback URL only if ChatGPT provides a custom one.</p></div>
        <input id="callback" type="url" spellCheck={false} placeholder="https://chatgpt.com/connector/oauth/…" value={draft.callbackUri} onChange={event => setDraft({ ...draft, callbackUri: event.target.value })} />
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

    const subscriptions = Promise.all([
      native.onState(next => { if (active) setState(next); }),
      native.onActivity(entry => merge([entry])),
      native.onClear(id => {
        cleared.current = Math.max(cleared.current, id);
        if (active) setEntries(current => current.filter(entry => entry.id > cleared.current));
      }),
    ]);
    void subscriptions.then(async () => {
      const [initial, history] = await Promise.all([native.state(), native.activity()]);
      if (active) setState(current => current ?? initial);
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
      <div className="brand"><span className="brand-icon"><Terminal /></span><div><strong>Desktop Commander</strong><span>Connect</span></div></div>
      <nav aria-label="Main navigation">{navigation.map(({ id, icon: Icon, name }) => <button key={id} type="button" aria-label={name} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon /><span>{name}</span></button>)}</nav>
      <div className="sidebar-footer"><Status phase={state?.phase ?? 'stopped'} /><button className="button quiet" type="button" aria-label={state?.canHide ? 'Hide to tray' : 'Minimize'} onClick={() => actions.run(native.hide)}><PanelTopClose /><span>{state?.canHide ? 'Hide to tray' : 'Minimize'}</span></button></div>
    </aside>
    <main>
      <header className="page-header"><h1>{selected.name}</h1><p>{selected.description}</p></header>
      {!state ? <div className="panel empty"><LoaderCircle className="spin" /><p>Loading Desktop Commander…</p></div> : <>
        {page === 'overview' && <Overview state={state} entries={entries} actions={actions} />}
        {page === 'setup' && <Setup state={state} actions={actions} />}
        {page === 'activity' && <ActivityPage entries={entries} actions={actions} />}
        {page === 'settings' && <SettingsPage state={state} actions={actions} />}
      </>}
    </main>
    {toast && <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <CircleAlert /> : <Check />}<span>{toast.message}</span></div>}
  </div>;
}
