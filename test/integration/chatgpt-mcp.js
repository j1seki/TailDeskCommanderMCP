import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

const callbacks = {
  chatgpt: 'https://chatgpt.com/connector_platform_oauth_redirect',
  gemini: 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-test',
};
const publicRelay = process.env.DC_CHATGPT_TEST_RELAY;
const externalUrl = process.env.DC_CHATGPT_TEST_URL;
const externalJson = process.env.DC_CHATGPT_TEST_JSON === '1';
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

async function checkConnection(t, provider, jsonResponses) {
  const gemini = provider === 'gemini';
  const callback = callbacks[provider];
  const otherProvider = gemini ? 'chatgpt' : 'gemini';
  const dir = await mkdtemp(join(tmpdir(), 'desktop-commander-chatgpt-'));
  let stopGateway;
  t.after(async () => {
    await stopGateway?.();
    await rm(dir, { force: true, recursive: true });
  });
  const stateDir = (externalUrl && process.env.DC_CHATGPT_TEST_STATE_DIR) || join(dir, 'oauth');
  const credentialPath = join(stateDir, `${provider}-oauth.json`);
  let existingCredentials;
  let gateway, events;
  let base = externalUrl;
  if (!base) {
    const testHome = join(dir, 'home');
    await mkdir(testHome);
    if (!gemini) {
      existingCredentials = {
        clientId: 'desktop-commander-chatgpt',
        clientSecret: randomBytes(32).toString('base64url'),
        loginPassword: randomBytes(32).toString('base64url'),
        signingKey: randomBytes(32).toString('base64url'),
      };
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(credentialPath, JSON.stringify(existingCredentials), { mode: 0o600 });
    }
    const entry = fileURLToPath(new URL('../../scripts/chatgpt-mcp.mjs', import.meta.url));
    gateway = spawn(process.execPath, [entry, '--local', '--desktop'], {
      env: {
        ...process.env, HOME: testHome, USERPROFILE: testHome, DC_CHATGPT_STATE_DIR: stateDir,
        DC_MCP_TUNNEL: jsonResponses ? 'cloudflare' : 'tailscale',
        DC_CHATGPT_LOCAL_PORT: '0', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const closed = once(gateway, 'close');
    stopGateway = async () => {
      gateway.stdin.end();
      await closed;
    };
    events = createInterface({ input: gateway.stdout })[Symbol.asyncIterator]();
    while (true) {
      const line = await events.next();
      if (line.done) break;
      const event = JSON.parse(line.value);
      if (event.type === 'gateway') {
        base = new URL(event.url).origin;
        break;
      }
      if (event.type === 'error') throw new Error(event.message);
    }
    assert.ok(base, 'The loopback gateway started');
  }

  const resource = `${base}/mcp`;
  const resourceParameter = gemini ? {} : { resource };
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

  if (!windows) assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const credentialFile = await readFile(credentialPath, 'utf8');
  if (existingCredentials) {
    assert.ok(credentialFile === JSON.stringify(existingCredentials), 'The existing ChatGPT credentials file was preserved');
  }
  const { clientId, clientSecret, loginPassword } = JSON.parse(credentialFile);
  const otherClient = JSON.parse(await readFile(join(stateDir, `${otherProvider}-oauth.json`), 'utf8'));
  const state = gemini ? '<&"opaque-state>'.repeat(90) : 'integration-state';
  const verifier = randomBytes(48).toString('base64url');
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback, ...resourceParameter,
    scope: 'desktop-commander', state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });

  const invalidRedirect = new URL(authorization);
  invalidRedirect.searchParams.set('redirect_uri', 'https://example.org/callback');
  const untrusted = await fetchMcp(invalidRedirect, { redirect: 'manual' });
  assert.equal(untrusted.status, 400);
  assert.equal(untrusted.headers.get('location'), null);
  invalidRedirect.searchParams.set('redirect_uri', callbacks[otherProvider]);
  assert.equal((await fetchMcp(invalidRedirect)).status, 400);

  const loginPage = await fetchMcp(authorization);
  assert.equal(loginPage.status, 200);
  assert.ok((await loginPage.text()).includes(`Allow ${gemini ? 'Gemini' : 'ChatGPT'} to use`));
  function postForm(url, fields, headers = {}) {
    return fetchMcp(url, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
    });
  }
  const badLogin = await postForm(authorization, { password: otherClient.loginPassword }, { Origin: base });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers.get('location'), null);
  async function callbackFrom(response) {
    if (!gemini) {
      assert.equal(response.status, 303);
      return new URL(response.headers.get('location'));
    }
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    const navigation = html.match(/<meta http-equiv="refresh" content="0; URL=([^"]+)">/)?.[1];
    assert.ok(navigation);
    assert.ok(html.includes(`href="${navigation}">Return to Gemini</a>`));
    return new URL(navigation.replaceAll('&amp;', '&'));
  }
  const denied = await postForm(authorization, { action: 'deny' }, { Origin: base });
  const denial = await callbackFrom(denied);
  assert.equal(denial.searchParams.get('error'), 'access_denied');
  assert.equal(denial.searchParams.get('iss'), base);

  const approved = await postForm(authorization, { password: loginPassword }, { Origin: base });
  const redirect = await callbackFrom(approved);
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), state);
  assert.equal(redirect.searchParams.get('iss'), base);
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  const exchange = {
    client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
    code, code_verifier: verifier, redirect_uri: callback, ...resourceParameter,
  };
  const badClient = await postForm(discovery.token_endpoint, { ...exchange, client_secret: 'wrong' });
  assert.equal(badClient.status, 401);
  const badTarget = await postForm(discovery.token_endpoint, { ...exchange, resource: 'https://example.org/mcp' });
  assert.equal((await badTarget.json()).error, 'invalid_target');
  const badPkce = await postForm(discovery.token_endpoint, { ...exchange, code_verifier: 'a'.repeat(43) });
  assert.equal((await badPkce.json()).error, 'invalid_grant');
  const crossClientCode = await postForm(discovery.token_endpoint, {
    ...exchange, client_id: otherClient.clientId, client_secret: otherClient.clientSecret, resource,
  });
  assert.equal((await crossClientCode.json()).error, 'invalid_grant');
  const tokenResponse = await postForm(discovery.token_endpoint, exchange);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  // Google Account Linking's token response schema specifies lowercase bearer.
  assert.equal(tokens.token_type, gemini ? 'bearer' : 'Bearer');
  assert.equal(tokens.scope, 'desktop-commander');
  assert.ok(tokens.refresh_token);
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
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, ...resourceParameter,
  }, { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.equal(refreshed.token_type, tokens.token_type);
  assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);
  t.diagnostic('OAuth login, exact callback, issuer and state, S256 exchange, replay rejection, and token refresh verified');

  let expectedResponse = false;
  let accessToken = refreshed.access_token;
  if (existingCredentials) {
    // Exercise the previous gateway's signed refresh-token format using its original signing key.
    const payload = Buffer.from(JSON.stringify({
      type: 'refresh', issuer: base, resource, client: clientId, scope: 'desktop-commander',
      expires: Math.floor(Date.now() / 1000) + 300, id: randomBytes(32).toString('base64url'),
    })).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(existingCredentials.signingKey, 'base64url'))
      .update(payload).digest('base64url');
    const priorGrant = await postForm(discovery.token_endpoint, {
      client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: `${payload}.${signature}`,
    });
    assert.equal(priorGrant.status, 200);
    accessToken = (await priorGrant.json()).access_token;
    t.diagnostic('Existing ChatGPT credentials were preserved and a pre-upgrade refresh token was accepted');
  }
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `${refreshed.token_type} ${accessToken}` } },
    fetch: async (url, options) => {
      const response = await fetchMcp(url, options);
      const contentType = jsonResponses ? 'application/json' : 'text/event-stream';
      if (options?.method === 'POST' && response.headers.get('content-type')?.startsWith(contentType)) expectedResponse = true;
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
  assert.ok(expectedResponse, 'The MCP server used the expected Streamable HTTP response type');
  t.diagnostic(`${jsonResponses ? 'JSON' : 'SSE'} initialize and tools/list (${tools.length} tools) succeeded. read_file returned the fixture and start_process ran a shell command.`);

  if (jsonResponses) {
    const stream = await fetchMcp(resource, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': transport.sessionId, Accept: 'text/event-stream' },
    });
    assert.equal(stream.status, 405);
  }

  const sessionId = transport.sessionId;
  await transport.terminateSession();
  const ended = await fetchMcp(resource, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': sessionId, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(ended.status, 404);

  if (gateway && gemini) {
    gateway.stdin.write(`${JSON.stringify({ action: 'revoke', provider })}\n`);
    while (true) {
      const line = await events.next();
      assert.ok(!line.done, 'Gateway stopped before revocation completed');
      const event = JSON.parse(line.value);
      if (event.type === 'log' && event.message.includes('Access revoked')) break;
    }
    const revoked = await fetchMcp(resource, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(revoked.status, 401);
    const rejectedRefresh = await postForm(discovery.token_endpoint, {
      client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    });
    assert.equal((await rejectedRefresh.json()).error, 'invalid_grant');
    assert.ok(await readFile(join(stateDir, 'chatgpt-oauth.json'), 'utf8') === JSON.stringify(otherClient, null, 2) + '\n');
    const after = JSON.parse(await readFile(credentialPath, 'utf8'));
    assert.ok(after.signingKey !== JSON.parse(credentialFile).signingKey);
    assert.ok(after.clientSecret === clientSecret && after.loginPassword === loginPassword);
    t.diagnostic('Revoking Gemini invalidated its access and refresh tokens while preserving ChatGPT credentials');
  }
}

for (const [provider, name] of [['chatgpt', 'ChatGPT'], ['gemini', 'Gemini']]) {
  for (const jsonResponses of externalUrl ? [externalJson] : [false, true]) {
    test(`${name} OAuth and Desktop Commander Streamable HTTP (${jsonResponses ? 'JSON' : 'SSE'})`,
      { timeout: 60_000 }, t => checkConnection(t, provider, jsonResponses));
  }
}

test('A registered Quick Tunnel remains open while HTTPS is being checked',
  { skip: windows || Boolean(externalUrl), timeout: 15_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'taildesk-quick-start-'));
    const connector = join(dir, 'cloudflared');
    const hostname = `taildesk-test-${randomBytes(8).toString('hex')}.trycloudflare.com`;
    await writeFile(connector, `#!/bin/sh\nprintf '%s\\n' 'https://${hostname}' 'Registered tunnel connection'\nexec sleep 60\n`,
      { mode: 0o700 });
    const entry = fileURLToPath(new URL('../../scripts/chatgpt-mcp.mjs', import.meta.url));
    const gateway = spawn(process.execPath, [entry, '--desktop'], {
      env: { ...process.env, DC_MCP_TUNNEL: 'cloudflare', DC_MCP_CLOUDFLARED: connector,
        DC_CHATGPT_STATE_DIR: join(dir, 'oauth'), DC_CHATGPT_LOCAL_PORT: '0' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const closed = once(gateway, 'close');
    t.after(async () => {
      gateway.stdin.end();
      await closed;
      await rm(dir, { force: true, recursive: true });
    });
    let ready = false;
    for await (const line of createInterface({ input: gateway.stdout })) {
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'gateway') assert.equal(event.url, `https://${hostname}/mcp`);
      if (event.type === 'ready') {
        ready = true;
        break;
      }
    }
    assert.ok(ready, 'Gateway did not wait for public DNS before emitting Ready');
  });
