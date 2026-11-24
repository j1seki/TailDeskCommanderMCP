import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SCOPE = 'desktop-commander';
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
const AUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
// Gemini Connected Apps uses Google-managed relay URLs generated for each connection.
const GEMINI_CALLBACK = /^https:\/\/oauth-redirect\.googleusercontent\.com\/[ra]\/[A-Za-z0-9_-]+$/;
const CODE_LIFETIME = 5 * 60;
const ACCESS_LIFETIME = 60 * 60;
const REFRESH_LIFETIME = 30 * 24 * 60 * 60;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const BASE64_SECRET = /^[A-Za-z0-9_-]{43}$/;

const randomSecret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

function secretMatches(value, expected) {
  return typeof value === 'string' && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(expected)));
}

export async function loadCredentials(provider = 'chatgpt') {
  const clientId = `desktop-commander-${provider}`;
  const windows = process.platform === 'win32';
  const configHome = windows
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const directory = resolve(process.env.DC_CHATGPT_STATE_DIR || join(configHome, 'desktop-commander'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const privateOnUnix = info => windows || (info.uid === process.getuid() && !(info.mode & 0o077));
  if (!info.isDirectory() || !privateOnUnix(info)) {
    throw new Error(`OAuth state directory must be owned by you and private (0700): ${directory}`);
  }

  const path = join(directory, `${provider}-oauth.json`);
  async function readCredentials() {
    if (windows && !(await lstat(path)).isFile()) throw new Error(`Expected a regular OAuth credentials file: ${path}`);
    const file = await open(path, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const info = await file.stat();
      if (!info.isFile() || !privateOnUnix(info) || info.size > 4096) {
        throw new Error(`OAuth credentials must be in a private regular file (0600): ${path}`);
      }
      const credentials = JSON.parse(await file.readFile('utf8'));
      if (credentials?.clientId !== clientId ||
        !['clientSecret', 'loginPassword', 'signingKey'].every(key =>
          typeof credentials[key] === 'string' && BASE64_SECRET.test(credentials[key]))) {
        throw new Error(`Invalid OAuth credentials file: ${path}`);
      }
      const { clientSecret, loginPassword, signingKey } = credentials;
      return { path, clientId, clientSecret, loginPassword, signingKey };
    } finally {
      await file.close();
    }
  }

  try {
    return await readCredentials();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = join(directory, `.oauth-${randomSecret()}`);
  await writeFile(temporary, JSON.stringify({
    clientId,
    clientSecret: randomSecret(),
    loginPassword: randomSecret(),
    signingKey: randomSecret(),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary);
  }
  return readCredentials();
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function readBody(request, maxSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxSize) {
      request.resume();
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readForm(request) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, 'Expected an application/x-www-form-urlencoded form');
  }
  const fields = new URLSearchParams(await readBody(request, 8192));
  if (new Set(fields.keys()).size !== fields.size) throw new HttpError(400, 'Duplicate form parameter');
  return fields;
}

function showLogin(response, client, incorrect = false) {
  response.writeHead(incorrect ? 401 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${client.gemini ? '' : ' https://chatgpt.com'}; frame-ancestors 'none'; base-uri 'none'`,
    'Referrer-Policy': 'same-origin',
  });
  response.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Desktop Commander</title>
<style>
  :root { color-scheme: light dark }
  body { font: 1rem system-ui; max-width: 32rem; margin: 12vh auto; padding: 0 1.25rem }
  input { box-sizing: border-box; width: 100%; margin: .4rem 0 1rem; padding: .65rem }
  button { padding: .55rem .85rem; margin-right: .4rem }
</style>
<h1>Authorize Desktop Commander</h1>
<p>Allow ${client.gemini ? 'Gemini' : 'ChatGPT'} to use the file and terminal tools on this machine.</p>
${incorrect ? '<p role="alert">Incorrect login password.</p>' : ''}
<form method="post">
  <label for="password">Desktop Commander login password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required autofocus>
  <button name="action" value="approve">Authorize</button>
  <button name="action" value="deny" formnovalidate>Cancel</button>
</form>
</html>`);
}

function finishAuthorization(response, callback, showContinuation) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!showContinuation) {
    response.writeHead(303, { ...headers, Location: callback.href });
    return response.end();
  }
  // A browser can apply the form's CSP to each HTTP redirect in Google's relay chain.
  // Start a separate navigation after the same-origin form submission has completed.
  const href = callback.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  response.writeHead(200, {
    ...headers, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Return to Gemini</title>
<meta http-equiv="refresh" content="0; URL=${href}">
<p><a href="${href}">Return to Gemini</a></p></html>`);
}

export function createOAuth(issuer, chatgpt, gemini) {
  const resource = `${issuer}/mcp`;
  const redirects = new Set([CHATGPT_CALLBACK]);
  const extraRedirect = process.env.DC_CHATGPT_REDIRECT_URI;
  if (extraRedirect) {
    if (!/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(extraRedirect)) {
      throw new Error('DC_CHATGPT_REDIRECT_URI must be the exact ChatGPT callback-ID-specific URL.');
    }
    redirects.add(extraRedirect);
  }
  const clients = new Map([
    [chatgpt.clientId, { ...chatgpt, gemini: false }],
    [gemini.clientId, { ...gemini, gemini: true }],
  ]);
  const codes = new Map();
  const sign = (client, value) => createHmac('sha256', Buffer.from(client.signingKey, 'base64url'))
    .update(value).digest('base64url');

  function mintToken(client, type, lifetime) {
    const payload = Buffer.from(JSON.stringify({
      type, issuer, resource, client: client.clientId, scope: SCOPE,
      expires: now() + lifetime, id: randomSecret(),
    })).toString('base64url');
    return `${payload}.${sign(client, payload)}`;
  }

  function verifyToken(client, token, type) {
    if (typeof token !== 'string' || token.length > 2048) return false;
    const [payload, signature, extra] = token.split('.');
    if (!signature || extra !== undefined || !secretMatches(signature, sign(client, payload))) return false;
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return grant.type === type && grant.issuer === issuer && grant.resource === resource &&
      grant.client === client.clientId && grant.scope === SCOPE && grant.expires > now();
  }

  function acceptsScope(scope) {
    return scope === null || scope === '' || scope === SCOPE;
  }

  async function authorize(request, response, query) {
    const client = clients.get(query.get('client_id'));
    const redirectUri = query.get('redirect_uri');
    if (new Set(query.keys()).size !== query.size || !client ||
      !(client.gemini ? GEMINI_CALLBACK.test(redirectUri ?? '') : redirects.has(redirectUri))) {
      return sendJson(response, 400, { error: 'invalid_request' });
    }
    const state = query.get('state');
    function redirect(key, value) {
      const callback = new URL(redirectUri);
      callback.searchParams.set(key, value);
      callback.searchParams.set('iss', issuer);
      if (state !== null) callback.searchParams.set('state', state);
      return finishAuthorization(response, callback, client.gemini && request.method === 'POST');
    }

    if (query.get('response_type') !== 'code') return redirect('error', 'unsupported_response_type');
    const challenge = query.get('code_challenge');
    if (query.get('code_challenge_method') !== 'S256' || !BASE64_SECRET.test(challenge ?? '')) {
      return redirect('error', 'invalid_request');
    }
    const requestedResource = query.get('resource');
    if (requestedResource !== resource && !(client.gemini && requestedResource === null)) {
      return redirect('error', 'invalid_target');
    }
    if (!acceptsScope(query.get('scope'))) return redirect('error', 'invalid_scope');
    if (request.method === 'GET') return showLogin(response, client);
    if (request.headers.origin && request.headers.origin !== issuer) throw new HttpError(403, 'Invalid Origin');

    const form = await readForm(request);
    if (form.get('action') === 'deny') return redirect('error', 'access_denied');
    if (!secretMatches(form.get('password'), client.loginPassword)) return showLogin(response, client, true);
    for (const [key, grant] of codes) {
      if (grant.expires <= now()) codes.delete(key);
    }
    if (codes.size >= 128) return redirect('error', 'temporarily_unavailable');
    const code = randomSecret();
    codes.set(digest(code), { clientId: client.clientId, challenge, redirectUri, expires: now() + CODE_LIFETIME });
    return redirect('code', code);
  }

  async function exchange(request, response) {
    const form = await readForm(request);
    let clientId = form.get('client_id');
    let secret = form.get('client_secret');
    const auth = request.headers.authorization;
    if (auth) {
      const basic = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(auth);
      if (!basic || secret !== null) return sendJson(response, 400, { error: 'invalid_request' });
      const [basicId, basicSecret, extra] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      if (extra !== undefined || (clientId !== null && clientId !== basicId)) {
        return sendJson(response, 400, { error: 'invalid_request' });
      }
      clientId = basicId;
      secret = basicSecret;
    }
    const client = clients.get(clientId);
    if (!client || !secretMatches(secret, client.clientSecret)) {
      if (auth) response.setHeader('WWW-Authenticate', 'Basic realm="Desktop Commander"');
      return sendJson(response, 401, { error: 'invalid_client' });
    }
    const grantType = form.get('grant_type');
    const requestedResource = form.get('resource');
    if (requestedResource !== resource && !(requestedResource === null && (client.gemini || grantType === 'refresh_token'))) {
      return sendJson(response, 400, { error: 'invalid_target' });
    }

    const tokens = { token_type: 'Bearer', expires_in: ACCESS_LIFETIME, scope: SCOPE };
    switch (grantType) {
      case 'authorization_code': {
        const key = digest(form.get('code') ?? '');
        const grant = codes.get(key);
        const verifier = form.get('code_verifier') ?? '';
        if (!grant || grant.clientId !== client.clientId || grant.expires <= now() || grant.redirectUri !== form.get('redirect_uri') ||
          !PKCE_VERIFIER.test(verifier) || !secretMatches(digest(verifier), grant.challenge)) {
          return sendJson(response, 400, { error: 'invalid_grant' });
        }
        codes.delete(key);
        tokens.refresh_token = mintToken(client, 'refresh', REFRESH_LIFETIME);
        break;
      }
      case 'refresh_token':
        if (!verifyToken(client, form.get('refresh_token'), 'refresh')) return sendJson(response, 400, { error: 'invalid_grant' });
        if (!acceptsScope(form.get('scope'))) return sendJson(response, 400, { error: 'invalid_scope' });
        break;
      default:
        return sendJson(response, 400, { error: 'unsupported_grant_type' });
    }
    return sendJson(response, 200, { ...tokens, access_token: mintToken(client, 'access', ACCESS_LIFETIME) });
  }

  return {
    authorizeMcp(request, response) {
      const authorization = request.headers.authorization;
      const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
      for (const client of clients.values()) {
        if (verifyToken(client, token, 'access')) return true;
      }
      const error = authorization ? ', error="invalid_token"' : '';
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}${RESOURCE_METADATA_PATH}", scope="${SCOPE}"${error}`);
      sendJson(response, 401, { error: authorization ? 'invalid_token' : 'authentication_required' });
      return false;
    },
    async handle(request, response, url) {
      const { pathname, searchParams } = url;
      if (request.method === 'GET' && (pathname === RESOURCE_METADATA_PATH || pathname === '/.well-known/oauth-protected-resource')) {
        return sendJson(response, 200, {
          resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'],
        });
      }
      if (request.method === 'GET' && pathname === AUTH_METADATA_PATH) {
        return sendJson(response, 200, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
          scopes_supported: [SCOPE],
        });
      }
      if (pathname === '/authorize' && ['GET', 'POST'].includes(request.method)) {
        return authorize(request, response, searchParams);
      }
      if (pathname === '/token' && request.method === 'POST') return exchange(request, response);
      return sendJson(response, 404, { error: 'not_found' });
    },
  };
}
