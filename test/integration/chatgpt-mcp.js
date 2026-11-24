import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const publicRelay = process.env.DC_CHATGPT_TEST_RELAY;
const externalUrl = process.env.DC_CHATGPT_TEST_URL;
const windows = process.platform === 'win32';

// Resolve the hostname to a public Funnel relay even when MagicDNS returns the tailnet IP.
function fetchMcp(url, options = {}) {
  if (!publicRelay) return fetch(url, options);
  return new Promise((resolve, reject) => {
    const connector = request(url, {
      method: options.method,
      headers: Object.fromEntries(new Headers(options.headers)),
      signal: options.signal,
      lookup: (_hostname, lookupOptions, done) => {
        if (lookupOptions.all) done(null, [{ address: publicRelay, family: 4 }]);
        else done(null, publicRelay, 4);
      },
    }, response => {
      const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response);
      resolve(new Response(body, { status: response.statusCode, headers: response.headers }));
    });
    connector.on('error', reject);
    connector.end(options.body?.toString());
  });
}

test('ChatGPT OAuth and Desktop Commander Streamable HTTP', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-commander-chatgpt-'));
  let stopGateway;
  t.after(async () => {
    await stopGateway?.();
    await rm(dir, { force: true, recursive: true });
  });
  const stateDir = process.env.DC_CHATGPT_TEST_STATE_DIR || join(dir, 'oauth');
  let base = externalUrl;
  if (!base) {
    const testHome = join(dir, 'home');
    await mkdir(testHome);
    const entry = fileURLToPath(new URL('../../scripts/chatgpt-mcp.mjs', import.meta.url));
    const gateway = spawn(process.execPath, [entry, '--local', '--desktop'], {
      env: {
        ...process.env, HOME: testHome, USERPROFILE: testHome, DC_CHATGPT_STATE_DIR: stateDir,
        DC_CHATGPT_LOCAL_PORT: '0', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const closed = once(gateway, 'close');
    stopGateway = async () => {
      gateway.stdin.end();
      await closed;
    };
    const lines = createInterface({ input: gateway.stdout });
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'gateway') {
        base = new URL(event.url).origin;
        break;
      }
      if (event.type === 'error') throw new Error(event.message);
    }
    assert.ok(base, 'The loopback gateway started');
  }

  const resource = `${base}/mcp`;
  const response = await fetchMcp(resource);
  assert.equal(response.status, 401);
  const unauthorizedPost = await fetchMcp(resource, { method: 'POST' });
  assert.equal(unauthorizedPost.status, 401);
  const challenge = response.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer.*scope="desktop-commander"/);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/mcp`);
  const metadata = await (await fetchMcp(metadataUrl)).json();
  assert.equal(metadata.resource, resource);
  assert.deepEqual(metadata.authorization_servers, [base]);
  const discovery = await (await fetchMcp(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(discovery.issuer, base);
  assert.equal(discovery.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
  t.diagnostic(`401 OAuth challenge and discovery verified at ${resource}${publicRelay ? ` via public relay ${publicRelay}` : ''}`);

  const credentialPath = join(stateDir, 'chatgpt-oauth.json');
  if (!windows) assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const { clientId, clientSecret, loginPassword } = JSON.parse(await readFile(credentialPath, 'utf8'));
  const verifier = randomBytes(48).toString('base64url');
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback, resource,
    scope: 'desktop-commander', state: 'integration-state', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });

  const invalidRedirect = new URL(authorization);
  invalidRedirect.searchParams.set('redirect_uri', 'https://example.org/callback');
  const untrusted = await fetchMcp(invalidRedirect, { redirect: 'manual' });
  assert.equal(untrusted.status, 400);
  assert.equal(untrusted.headers.get('location'), null);

  const loginPage = await fetchMcp(authorization);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Authorize Desktop Commander/);
  function postForm(url, fields, headers = {}) {
    return fetchMcp(url, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
    });
  }
  const badLogin = await postForm(authorization, { password: 'wrong' }, { Origin: base });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers.get('location'), null);
  const denied = await postForm(authorization, { action: 'deny' }, { Origin: base });
  const denial = new URL(denied.headers.get('location'));
  assert.equal(denial.searchParams.get('error'), 'access_denied');
  assert.equal(denial.searchParams.get('iss'), base);

  const approved = await postForm(authorization, { password: loginPassword }, { Origin: base });
  assert.equal(approved.status, 303);
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), 'integration-state');
  assert.equal(redirect.searchParams.get('iss'), base);
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  const exchange = {
    client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
    code, code_verifier: verifier, redirect_uri: callback, resource,
  };
  const badClient = await postForm(discovery.token_endpoint, { ...exchange, client_secret: 'wrong' });
  assert.equal(badClient.status, 401);
  const badTarget = await postForm(discovery.token_endpoint, { ...exchange, resource: 'https://example.org/mcp' });
  assert.equal((await badTarget.json()).error, 'invalid_target');
  const badPkce = await postForm(discovery.token_endpoint, { ...exchange, code_verifier: 'a'.repeat(43) });
  assert.equal((await badPkce.json()).error, 'invalid_grant');
  const tokenResponse = await postForm(discovery.token_endpoint, exchange);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.scope, 'desktop-commander');
  const replay = await postForm(discovery.token_endpoint, exchange);
  assert.equal((await replay.json()).error, 'invalid_grant');
  const wrongTokenType = await fetchMcp(resource, { headers: { Authorization: `Bearer ${tokens.refresh_token}` } });
  assert.equal(wrongTokenType.status, 401);
  const tampered = `${tokens.access_token.slice(0, -1)}${tokens.access_token.endsWith('a') ? 'b' : 'a'}`;
  const badSignature = await fetchMcp(resource, { headers: { Authorization: `Bearer ${tampered}` } });
  assert.equal(badSignature.status, 401);
  const invalidOrigin = await fetchMcp(resource, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: 'https://example.org' },
  });
  assert.equal(invalidOrigin.status, 403);
  const refresh = await postForm(discovery.token_endpoint, {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource,
  }, { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);
  t.diagnostic('OAuth login, exact callback, issuer and state, S256 exchange, replay rejection, and token refresh verified');

  let streamed = false;
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } },
    fetch: async (url, options) => {
      const response = await fetchMcp(url, options);
      if (options?.method === 'POST' && response.headers.get('content-type')?.startsWith('text/event-stream')) streamed = true;
      return response;
    },
  });
  const client = new Client({ name: 'desktop-commander-https-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'desktop-commander');
  assert.ok(transport.sessionId);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'start_process'));
  const read = tools.find(tool => tool.name === 'read_file');
  assert.deepEqual(read?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['desktop-commander'] }]);
  const fixture = join(dir, 'funnel-proof.txt');
  await writeFile(fixture, 'Desktop Commander HTTPS proof\n');
  const result = await client.callTool({ name: 'read_file', arguments: { path: fixture } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(result.content.some(item => item.type === 'text' && item.text.includes('Desktop Commander HTTPS proof')));
  const command = await client.callTool({
    name: 'start_process',
    arguments: windows
      ? { command: 'echo Desktop Commander shell proof', shell: 'cmd.exe', timeout_ms: 3000 }
      : { command: "printf 'Desktop Commander shell proof\\n'", timeout_ms: 3000 },
  });
  assert.ok(command.content.some(item => item.type === 'text' &&
    /^Process started with PID \d+[\s\S]*Initial output:\nDesktop Commander shell proof/.test(item.text)),
  JSON.stringify(command.content));
  assert.ok(streamed, 'The MCP server sent SSE responses over Streamable HTTP');
  t.diagnostic(`SSE initialize and tools/list (${tools.length} tools) succeeded. read_file returned the fixture and start_process ran a shell command.`);

  const sessionId = transport.sessionId;
  await transport.terminateSession();
  const ended = await fetchMcp(resource, {
    headers: { Authorization: `Bearer ${refreshed.access_token}`, 'Mcp-Session-Id': sessionId, Accept: 'text/event-stream' },
  });
  assert.equal(ended.status, 404);
});
