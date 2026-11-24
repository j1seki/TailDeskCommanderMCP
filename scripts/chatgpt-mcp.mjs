import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { get } from 'node:https';
import { isIPv4 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InitializeRequestSchema, isJSONRPCErrorResponse, isJSONRPCRequest, isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { createOAuth, HttpError, loadCredentials, readBody, sendJson, SCOPE } from './chatgpt-oauth.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const mcpPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const SESSION_IDLE_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 16;
const MAX_MCP_BODY = 8 * 1024 * 1024;
const FUNNEL_PORTS = [443, 8443, 10000];
const desktop = process.argv.includes('--desktop');
const tailscale = process.env.DC_CHATGPT_TAILSCALE || 'tailscale';
const cloudflared = process.env.DC_MCP_CLOUDFLARED || 'cloudflared';
const providerNames = { chatgpt: 'ChatGPT', gemini: 'Gemini' };

function emit(type, fields = {}) {
  if (desktop) console.log(JSON.stringify({ type, ...fields }));
}

function log(source, message, level = 'info') {
  emit('log', { source, message, level });
}

function report(component, status, message, provider) {
  emit('diagnostic', { component, status, provider });
  const source = component === 'oauth' ? 'OAuth' : component === 'mcp' ? 'MCP' : 'Tunnel';
  const detail = provider ? `${providerNames[provider]}: ${message}` : message;
  if (desktop) log(source, detail, status === 'failed' ? 'warning' : 'info');
  else if (component === 'oauth' || component === 'https') console.log(detail);
}

function redactSetupLinks(message) {
  return message.replace(/https:\/\/login\.tailscale\.com\/\S+/gi, '[Tailscale setup link]');
}

async function getFunnelAddress() {
  log('Funnel', 'Checking Tailscale and available HTTPS ports.');
  const [status, serving] = await Promise.all([
    run(tailscale, ['status', '--json'], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }),
    run(tailscale, ['funnel', 'status', '--json'], { windowsHide: true, timeout: 15_000 }),
  ]);
  const node = JSON.parse(status.stdout);
  const hostname = node.Self?.DNSName?.replace(/\.$/, '');
  if (node.BackendState !== 'Running' || !hostname?.endsWith('.ts.net')) {
    throw new Error('Connect Tailscale and enable MagicDNS for the node before starting Funnel.');
  }

  const config = JSON.parse(serving.stdout) ?? {};
  const configured = [config, ...Object.values(config.Foreground ?? {})];
  const requested = process.env.DC_CHATGPT_FUNNEL_PORT;
  const candidates = requested ? [Number(requested)] : FUNNEL_PORTS;
  if (!candidates.every(port => FUNNEL_PORTS.includes(port))) {
    throw new Error('DC_CHATGPT_FUNNEL_PORT must be 443, 8443, or 10000.');
  }
  // A port's public/private setting covers every route on that port.
  const port = candidates.find(port => configured.every(entry => !entry.TCP?.[port] &&
    !Object.keys(entry.Web ?? {}).some(host => host.endsWith(`:${port}`))));
  if (!port) throw new Error('Requested Tailscale port(s) already have Serve or Funnel routes. Choose a free Funnel port.');
  return { port, issuer: new URL(`https://${hostname}:${port}`).origin };
}

function createMcpBridge(oauth, jsonResponses) {
  const sessions = new Map();
  const connections = new Set();
  let closing = false;

  async function createSession(provider) {
    if (closing) throw new HttpError(503, 'MCP server is shutting down');
    if (connections.size >= MAX_SESSIONS) throw new HttpError(503, 'Too many active MCP sessions');
    const stdio = new StdioClientTransport({
      command: process.execPath, args: [mcpPath, '--no-onboarding'], cwd: root,
      env: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY === undefined ? undefined : {
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY,
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessions.set(id, connection); },
      enableJsonResponse: jsonResponses,
    });
    const connection = { transport, provider, lastActive: Date.now(), close };
    connections.add(connection);

    async function close() {
      if (!connections.delete(connection)) return;
      if (transport.sessionId) sessions.delete(transport.sessionId);
      await Promise.all([transport.close(), stdio.close()]);
    }

    const pending = new Map();
    transport.onclose = () => { void close(); };
    stdio.onclose = () => { void close(); };
    transport.onmessage = message => {
      if (isJSONRPCRequest(message)) pending.set(message.id, message);
      void stdio.send(message).catch(() => close());
    };
    stdio.onmessage = message => {
      const request = pending.get(message.id);
      if (message.id !== undefined && !isJSONRPCRequest(message)) pending.delete(message.id);
      if (request?.method === 'initialize' && isJSONRPCResultResponse(message)) {
        report('mcp', 'passed', 'Opened an authenticated MCP session.', provider);
      } else if (request?.method === 'initialize' && isJSONRPCErrorResponse(message)) {
        report('mcp', 'failed', 'The MCP runtime rejected session initialization.', provider);
      }
      if (request?.method === 'tools/list' && isJSONRPCResultResponse(message) && Array.isArray(message.result.tools)) {
        const securitySchemes = [{ type: 'oauth2', scopes: [SCOPE] }];
        message.result.tools = message.result.tools.map(tool => ({
          ...tool, securitySchemes, _meta: { ...tool._meta, securitySchemes },
        }));
      }
      const related = message.method === 'notifications/progress' && [...pending.values()].find(request =>
        request.params?._meta?.progressToken === message.params?.progressToken);
      // A canceled HTTP request may already have disconnected when stdio replies.
      void transport.send(message, { relatedRequestId: related?.id }).catch(() => {});
    };

    try {
      await stdio.start();
      await transport.start();
      return connection;
    } catch (error) {
      await close();
      throw error;
    }
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of connections) {
      if (session.lastActive < cutoff) void session.close();
    }
  }, 60_000);
  sweep.unref();

  return {
    async handle(request, response) {
      const provider = oauth.authorizeMcp(request, response);
      if (!provider) return;
      if (jsonResponses && request.method === 'GET') {
        response.setHeader('Allow', 'POST, DELETE');
        return sendJson(response, 405, { error: 'SSE is unavailable on this tunnel' });
      }
      const sessionId = request.headers['mcp-session-id'];
      let session = sessions.get(sessionId);
      if (sessionId && session?.provider !== provider) {
        return sendJson(response, 404, {
          jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null,
        });
      }
      let body;
      if (request.method === 'POST') {
        const raw = await readBody(request, MAX_MCP_BODY);
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(response, 400, {
            jsonrpc: '2.0', error: { code: -32700, message: 'Invalid JSON' }, id: null,
          });
        }
      }
      if (!session && (request.method !== 'POST' || !InitializeRequestSchema.safeParse(body).success)) {
        return sendJson(response, 400, {
          jsonrpc: '2.0', error: { code: -32000, message: 'Initialize an MCP session first' }, id: null,
        });
      }
      const newSession = !session;
      session ??= await createSession(provider);
      session.lastActive = Date.now();
      try {
        await session.transport.handleRequest(request, response, body);
      } finally {
        if (newSession && !session.transport.sessionId) await session.close();
      }
    },
    async revoke(provider) {
      await Promise.all([...connections].filter(connection => connection.provider === provider).map(connection => connection.close()));
    },
    async close() {
      closing = true;
      clearInterval(sweep);
      await Promise.all([...connections].map(session => session.close()));
    },
  };
}

function startFunnel(args, ready, useSudo = false) {
  const interactive = useSudo && process.stdin.isTTY;
  const stdio = [interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'];
  const options = { stdio, windowsHide: true };
  const child = useSudo
    ? spawn('sudo', [...(interactive ? [] : ['-n']), tailscale, ...args], options)
    : spawn(tailscale, args, options);
  let errors = '';
  child.stderr.on('data', chunk => {
    errors = (errors + chunk.toString()).slice(-4096);
    if (!desktop) process.stderr.write(chunk);
  });
  if (desktop) {
    let setupUrl;
    function handleLine(line) {
      if (line.includes('Available on the internet:')) ready();
      const url = line.match(/https:\/\/login\.tailscale\.com\/[a-zA-Z0-9_/?=&%.-]+/)?.[0];
      if (url && url !== setupUrl) {
        setupUrl = url;
        emit('enable', { setupUrl });
      }
    }
    createInterface({ input: child.stdout }).on('line', handleLine);
    createInterface({ input: child.stderr }).on('line', handleLine);
  } else {
    child.stdout.pipe(process.stdout, { end: false });
  }
  const closed = once(child, 'close').then(() => errors);
  return { child, closed };
}

function startQuickTunnel(localPort, config) {
  const child = spawn(cloudflared, [
    'tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${localPort}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  const address = new Promise((resolve, reject) => {
    let lastError, url;
    let registered = false;
    const timeout = setTimeout(() => reject(new Error('Cloudflare did not register the Quick Tunnel in time.')), 35_000);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => {
        if (/\bERR\b|\bfailed\b/i.test(line)) lastError = line.slice(0, 500);
        url ??= line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];
        registered ||= line.includes('Registered tunnel connection');
        if (url && registered) {
          clearTimeout(timeout);
          resolve(new URL(url).origin);
        }
      });
    }
    child.once('error', error => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? 'Install cloudflared to start a Quick Tunnel.' : 'Could not start cloudflared.'));
    });
    void closed.then(() => {
      clearTimeout(timeout);
      reject(new Error(lastError || 'cloudflared exited before registering the Quick Tunnel.'));
    });
  });
  return { child, closed, address };
}

async function probeQuickTunnel(endpoint, resolver, signal) {
  const url = new URL(endpoint);
  const dns = new URL(resolver);
  dns.search = new URLSearchParams({ name: url.hostname, type: 'A' });
  const answer = await fetch(dns, { signal, headers: { Accept: 'application/dns-json' } });
  const { Answer = [] } = await answer.json();
  const addresses = Answer.filter(record => record.type === 1 && isIPv4(record.data));
  if (!addresses.length) return false;
  return new Promise((resolve, reject) => {
    const request = get(url, {
      signal,
      lookup: (_name, options, done) => {
        if (options.all) done(null, addresses.map(({ data }) => ({ address: data, family: 4 })));
        else done(null, addresses[0].data, 4);
      },
    }, async response => {
      try {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(false);
        } else {
          const metadata = JSON.parse(await readBody(response, 8192));
          resolve(metadata.resource === `${url.origin}/mcp`);
        }
      } catch (error) {
        reject(error);
      }
    });
    request.once('error', reject);
  });
}

async function checkHttps(issuer, shutdownSignal, quick = false) {
  const endpoint = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(quick ? 60_000 : 20_000)]);
  const resolvers = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const response = await fetch(endpoint, {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      });
      if (response.ok && (await response.json()).resource === `${issuer}/mcp`) return true;
    } catch {
      // DNS and routing may still be propagating.
    }
    if (quick && !signal.aborted) {
      const reachable = await probeQuickTunnel(endpoint, resolvers[attempt % resolvers.length],
        AbortSignal.any([signal, AbortSignal.timeout(3_000)])).catch(() => false);
      if (reachable) return true;
    }
    await delay(1_000, undefined, { signal }).catch(() => {});
  }
  return false;
}

async function main() {
  const local = process.argv.includes('--local');
  const tunnelMode = process.env.DC_MCP_TUNNEL || 'tailscale';
  if (!['tailscale', 'cloudflare'].includes(tunnelMode)) throw new Error('DC_MCP_TUNNEL must be tailscale or cloudflare.');
  const quick = !local && tunnelMode === 'cloudflare';
  const requestedPort = Number(process.env.DC_CHATGPT_LOCAL_PORT || 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('DC_CHATGPT_LOCAL_PORT must be a TCP port number or 0 for automatic assignment.');
  }
  const funnel = local || quick ? undefined : await getFunnelAddress();
  const [chatgpt, gemini] = await Promise.all([loadCredentials(), loadCredentials('gemini')]);
  let issuer, oauth, bridge, tunnel, quickConfig, input;
  let stopping = false;
  let controls = Promise.resolve();
  const shutdownSignal = new AbortController();

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (request, response) => {
    try {
      if (!oauth) return sendJson(response, 503, { error: 'gateway_starting' });
      const url = new URL(request.url, issuer);
      if (request.headers.host !== new URL(issuer).host || url.origin !== issuer) {
        throw new HttpError(403, 'Invalid host');
      }
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (url.pathname === '/mcp') {
        if (request.headers.origin && request.headers.origin !== issuer) throw new HttpError(403, 'Invalid Origin');
        if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
          response.setHeader('Allow', 'GET, POST, DELETE');
          throw new HttpError(405, 'Method not allowed');
        }
        await bridge.handle(request, response);
      } else if (url.pathname === '/' && request.method === 'GET') {
        sendJson(response, 200, { service: 'Desktop Commander', mcp: `${issuer}/mcp` });
      } else {
        await oauth.handle(request, response, url);
      }
    } catch (error) {
      if (!(error instanceof HttpError)) {
        if (desktop) log('MCP', 'The endpoint could not complete a request.', 'error');
        else console.error(`Request failed: ${error.message}`);
      }
      if (!response.headersSent) {
        sendJson(response, error.status ?? 500, { error: error instanceof HttpError ? error.message : 'internal_error' });
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }
  });

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    shutdownSignal.abort();
    input?.close();
    if (desktop) process.stdin.pause();
    tunnel?.child.kill('SIGTERM');
    server.close();
    server.closeAllConnections();
    await Promise.allSettled([bridge?.close(), tunnel?.closed, controls]);
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  if (desktop) {
    input = createInterface({ input: process.stdin });
    input.on('line', line => {
      if (stopping || !oauth) return;
      try {
        const { action, provider } = JSON.parse(line);
        if (action !== 'revoke' || typeof provider !== 'string' || !Object.hasOwn(providerNames, provider)) return;
        controls = controls.then(async () => {
          await oauth.revoke(provider);
          await bridge.revoke(provider);
          emit('diagnostic', { component: 'mcp', provider, status: 'waiting' });
          report('oauth', 'waiting', 'Access revoked. Link again to reconnect.', provider);
        }).catch(() => {
          report('oauth', 'failed', 'Could not revoke access. Check local credentials permissions.', provider);
        });
      } catch {
        // Ignore malformed desktop commands.
      }
    });
    process.stdin.once('end', () => { void shutdown(); });
  }

  try {
    server.listen(requestedPort, '127.0.0.1');
    await once(server, 'listening');
    const localPort = server.address().port;
    if (quick) {
      log('Tunnel', 'Requesting a temporary Cloudflare URL.');
      quickConfig = await mkdtemp(join(tmpdir(), 'taildesk-quick-'));
      const config = join(quickConfig, 'config.yml');
      await writeFile(config, '{}\n');
      if (stopping) return;
      tunnel = startQuickTunnel(localPort, config);
      issuer = await tunnel.address;
    } else {
      issuer = funnel?.issuer ?? `http://127.0.0.1:${localPort}`;
    }
    oauth = createOAuth(issuer, chatgpt, gemini, (provider, status, message) => report('oauth', status, message, provider));
    bridge = createMcpBridge(oauth, tunnelMode === 'cloudflare');

    if (desktop) {
      emit('gateway', {
        url: `${issuer}/mcp`, credentialsPath: chatgpt.path, clientId: chatgpt.clientId,
        geminiCredentialsPath: gemini.path, geminiClientId: gemini.clientId,
      });
      log('MCP', `OAuth gateway listening on loopback port ${localPort}.`);
    } else {
      console.log(`MCP URL: ${issuer}/mcp`);
      console.log('Authentication: OAuth');
      console.log(`OAuth client ID: ${chatgpt.clientId}`);
      console.log(`OAuth client secret and login password: ${chatgpt.path}`);
      console.log(`Gemini OAuth client ID: ${gemini.clientId}`);
      console.log(`Gemini OAuth client secret and login password: ${gemini.path}`);
    }

    function reportHttps(passed) {
      if (stopping) return;
      report('https', passed ? 'passed' : 'failed', passed
        ? 'HTTPS endpoint and OAuth discovery responded.'
        : 'Could not verify the HTTPS endpoint. Check the tunnel connection.');
    }
    if (quick) {
      emit('ready');
      // A slow resolver should not terminate a registered tunnel or discard its hostname.
      void checkHttps(issuer, shutdownSignal.signal, true).then(reportHttps);
      await tunnel.closed;
      if (!stopping) throw new Error('The Cloudflare Quick Tunnel closed. Start a new connection to get a new URL.');
    } else if (funnel) {
      log('Funnel', `Opening the public HTTPS route on port ${funnel.port}.`);
      const args = ['funnel', `--https=${funnel.port}`, `http://127.0.0.1:${localPort}`];
      const ready = () => {
        emit('ready');
        void checkHttps(issuer, shutdownSignal.signal).then(reportHttps);
      };
      tunnel = startFunnel(args, ready);
      let errors = await tunnel.closed;
      const denied = /access denied|permission denied|not an operator/i;
      if (!stopping && process.platform !== 'win32' && denied.test(errors)) {
        // Elevate only the Tailscale CLI. Desktop Commander runs as the invoking user.
        log('Funnel', 'Retrying Tailscale with administrator permissions.');
        tunnel = startFunnel(args, ready, true);
        errors = await tunnel.closed;
      }
      if (!stopping) {
        if (desktop && /access denied|permission denied|not an operator|password is required/i.test(errors)) {
          throw new Error(process.platform === 'win32'
            ? 'Tailscale denied Funnel access. Sign in to Tailscale on this Windows account, then retry.'
            : 'Tailscale needs operator permission. On Linux, run sudo tailscale set --operator="$USER" in your terminal, then retry.');
        }
        throw new Error(desktop && errors.trim() ? errors.trim() : 'Funnel stopped. Check your Tailscale Funnel permissions.');
      }
    } else {
      emit('ready');
      await once(server, 'close');
    }
  } finally {
    await shutdown();
    if (quickConfig) await rm(quickConfig, { force: true, recursive: true });
  }
}

main().catch(error => {
  if (desktop) emit('error', { message: redactSetupLinks(error.message).slice(0, 1600) });
  else console.error(`Could not start MCP gateway: ${error.message}`);
  process.exitCode = 1;
});
