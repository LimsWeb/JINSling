// Production uses Firebase's password verifier. Never import the Node-only
// development provider here or replace human passwords with a fast hash.
const IDENTITY_ORIGIN = 'https://identitytoolkit.googleapis.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';
const METHODS = ['createUser', 'verifyPassword', 'setPassword', 'deleteUser'];
const providers = new WeakMap();
const messages = Object.freeze({
  INVALID_CREDENTIALS: 'The supplied credentials are not valid.',
  USERNAME_TAKEN: 'That username is already registered.',
  UNAVAILABLE: 'The password provider is temporarily unavailable.',
  NOT_CONFIGURED: 'The password provider is not configured.',
});
const rejectionReasons = Object.freeze({
  API_KEY_INVALID: 'API_KEY_INVALID', INVALID_API_KEY: 'API_KEY_INVALID',
  API_KEY_SERVICE_BLOCKED: 'API_KEY_RESTRICTED', API_KEY_HTTP_REFERRER_BLOCKED: 'API_KEY_RESTRICTED',
  API_KEY_IP_ADDRESS_BLOCKED: 'API_KEY_RESTRICTED', SERVICE_DISABLED: 'API_DISABLED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND', CONFIGURATION_NOT_FOUND: 'CONFIGURATION_NOT_FOUND',
  OPERATION_NOT_ALLOWED: 'PROVIDER_DISABLED', EMAIL_EXISTS: 'EMAIL_EXISTS', INVALID_EMAIL: 'INVALID_EMAIL',
  WEAK_PASSWORD: 'PASSWORD_POLICY', PASSWORD_DOES_NOT_MEET_REQUIREMENTS: 'PASSWORD_POLICY',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'RATE_LIMITED', QUOTA_EXCEEDED: 'RATE_LIMITED',
  CAPTCHA_CHECK_FAILED: 'CAPTCHA_REQUIRED', MISSING_RECAPTCHA_TOKEN: 'CAPTCHA_REQUIRED',
  INVALID_RECAPTCHA_TOKEN: 'CAPTCHA_REQUIRED',
});
const diagnosticReasons = new Set([...Object.values(rejectionReasons),
  'ACCESS_DENIED', 'PROVIDER_REJECTED', 'PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT', 'TRANSPORT_FAILURE',
  'INVALID_JSON', 'RESPONSE_SHAPE_INVALID', 'IDENTITY_TOKEN', 'IDENTITY_PROJECT', 'IDENTITY_UID',
  'IDENTITY_EMAIL', 'IDENTITY_PROVIDER', 'IDENTITY_TIME',
]);
function safeDiagnostic(value) {
  if (!value || !['create', 'verify', 'oauth', 'update', 'delete'].includes(value.operation)
    || !diagnosticReasons.has(value.reason) || !Number.isInteger(value.status)
    || !(value.status === 0 || (value.status >= 100 && value.status <= 599))) return undefined;
  return Object.freeze({ operation: value.operation, reason: value.reason, status: value.status });
}

export class AuthProviderError extends Error {
  constructor(code = 'UNAVAILABLE', diagnostic) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'UNAVAILABLE';
    super(messages[safeCode]);
    this.name = 'AuthProviderError';
    this.code = safeCode;
    const safe = safeDiagnostic(diagnostic);
    if (safe) this.diagnostic = safe;
  }
}

// Call only after the bootstrap token and unconfigured state have been checked.
// Revalidate at the display boundary; never serialize an exception or Google body.
export function bootstrapAuthDiagnostic(error) {
  const detail = error instanceof AuthProviderError ? safeDiagnostic(error.diagnostic) : undefined;
  return detail?.operation === 'create' ? `[진단: CREATE/${detail.reason}/HTTP${detail.status}]` : '';
}

function injectedAuth(env) {
  // AUTH is a trusted server dependency, injected explicitly by tests/dev. A
  // request body, browser token, string binding, or partial object cannot use it.
  const auth = env?.AUTH;
  return auth && typeof auth === 'object' && METHODS.every(method => typeof auth[method] === 'function') ? auth : null;
}

function configuration(env) {
  try {
    const apiKey = env?.FIREBASE_API_KEY, projectId = env?.FIREBASE_PROJECT_ID;
    if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(apiKey)
      || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
      || typeof env.FIREBASE_SERVICE_ACCOUNT_JSON !== 'string') throw new Error();
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!account || account.type !== 'service_account' || account.project_id !== projectId
      || typeof account.client_email !== 'string'
      || !new RegExp(`^[a-z0-9][a-z0-9._-]*@${projectId}\\.iam\\.gserviceaccount\\.com$`).test(account.client_email)
      || typeof account.private_key !== 'string' || account.private_key.length > 12000
      || !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\r?\n?$/.test(account.private_key)
      || (account.private_key_id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(account.private_key_id))
      || (account.token_uri !== undefined && account.token_uri !== TOKEN_ENDPOINT)) throw new Error();
    return { apiKey, projectId, email: account.client_email, privateKey: account.private_key, keyId: account.private_key_id };
  } catch {
    throw new AuthProviderError('NOT_CONFIGURED');
  }
}

export function passwordAuthReady(env) {
  if (injectedAuth(env)) return true;
  try { configuration(env); return true; } catch { return false; }
}

export function createPasswordAuth(env) {
  const trusted = injectedAuth(env);
  if (trusted) return trusted;
  const config = configuration(env);
  const previous = providers.get(env);
  if (previous && previous.apiKey === env.FIREBASE_API_KEY && previous.projectId === env.FIREBASE_PROJECT_ID
    && previous.serviceAccount === env.FIREBASE_SERVICE_ACCOUNT_JSON) return previous.auth;
  const auth = firebaseAuth(config);
  providers.set(env, { apiKey: env.FIREBASE_API_KEY, projectId: env.FIREBASE_PROJECT_ID, serviceAccount: env.FIREBASE_SERVICE_ACCOUNT_JSON, auth });
  return auth;
}

function passwordValue(value) {
  if (typeof value !== 'string') throw new AuthProviderError('INVALID_CREDENTIALS');
  const length = Array.from(value).length;
  if (length < 15 || length > 128) throw new AuthProviderError('INVALID_CREDENTIALS');
  return value; // Whitespace and Unicode are meaningful; never trim passwords.
}

function alias(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{4,32}$/.test(username)) throw new AuthProviderError('INVALID_CREDENTIALS');
  // This email-shaped identifier is not a real mailbox. Firebase acceptance of
  // .invalid is an explicit live deployment gate; local tests cannot prove it.
  return `${username.toLowerCase()}@jinsling-auth.invalid`;
}

function uidValue(uid) {
  if (typeof uid !== 'string' || !uid.length || uid.length > 128) throw new AuthProviderError('INVALID_CREDENTIALS');
  return uid;
}

function errorCode(response, data, operation) {
  if (response.status === 429 || response.status >= 500) return 'UNAVAILABLE';
  const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
  const code = typeof message === 'string' ? message.split(/[ :]/, 1)[0] : '';
  if (operation === 'oauth') return ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope'].includes(code)
    || response.status === 401 || response.status === 403 ? 'NOT_CONFIGURED' : 'UNAVAILABLE';
  if (['API_KEY_INVALID', 'INVALID_API_KEY', 'PROJECT_NOT_FOUND', 'CONFIGURATION_NOT_FOUND', 'OPERATION_NOT_ALLOWED'].includes(code)
    || response.status === 403) return 'NOT_CONFIGURED';
  if (operation === 'create' && code === 'EMAIL_EXISTS') return 'USERNAME_TAKEN';
  if (['INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'USER_DISABLED', 'USER_NOT_FOUND'].includes(code)) return 'INVALID_CREDENTIALS';
  return 'UNAVAILABLE';
}

function rejectionReason(response, data) {
  if (response.status === 429) return 'RATE_LIMITED';
  if (response.status >= 500) return 'PROVIDER_UNAVAILABLE';
  const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
  if (message === 'API key not valid. Please pass a valid API key.') return 'API_KEY_INVALID';
  const code = typeof message === 'string' ? message.split(/[ :]/, 1)[0] : '';
  if (Object.hasOwn(rejectionReasons, code)) return rejectionReasons[code];
  if (Array.isArray(data?.error?.details)) {
    for (const detail of data.error.details) {
      if (detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
        && typeof detail.reason === 'string' && Object.hasOwn(rejectionReasons, detail.reason)) return rejectionReasons[detail.reason];
    }
  }
  return response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'PROVIDER_REJECTED';
}

async function requestJson(url, body, operation, authorization) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let status = 0;
  try {
    const form = body instanceof URLSearchParams;
    const headers = { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    const response = await fetch(url, {
      method: 'POST', headers, body: form ? body.toString() : JSON.stringify(body),
      redirect: 'error', signal: controller.signal,
    });
    status = response.status;
    let data;
    try { data = await response.json(); }
    catch { throw new AuthProviderError('UNAVAILABLE', { operation, status, reason: controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'INVALID_JSON' }); }
    if (!response.ok) throw new AuthProviderError(errorCode(response, data, operation), { operation, status, reason: rejectionReason(response, data) });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new AuthProviderError('UNAVAILABLE', { operation, status, reason: 'RESPONSE_SHAPE_INVALID' });
    return { data, status };
  } catch (error) {
    if (error instanceof AuthProviderError) throw error;
    // Never propagate a fetch URL, raw Google response, token, or secret via
    // message/cause/stack. Diagnostics contain only fixed enums and HTTP status.
    throw new AuthProviderError('UNAVAILABLE', { operation, status, reason: controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'TRANSPORT_FAILURE' });
  } finally { clearTimeout(timeout); }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
const encodeJson = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
function decodeJson(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function receivedIdentity(data, expectedEmail, projectId, operation, status) {
  let reason = 'IDENTITY_UID';
  try {
    const uid = uidValue(data.localId);
    reason = 'IDENTITY_TOKEN';
    if (typeof data.idToken !== 'string' || data.idToken.length > 16384) throw new Error();
    const parts = data.idToken.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const header = decodeJson(parts[0]), claims = decodeJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    // This is NOT a general JWT verifier: data comes exclusively from our own
    // fixed Google HTTPS request. Never call this with a browser-supplied JWT.
    // Google authenticates the password; claims pin that response to our project
    // and requested account without trusting the caller's asserted identity.
    if (header.alg !== 'RS256' || !claims || typeof claims !== 'object') throw new Error();
    reason = 'IDENTITY_PROJECT';
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error();
    reason = 'IDENTITY_UID';
    if (claims.sub !== uid || (claims.user_id !== undefined && claims.user_id !== uid)) throw new Error();
    reason = 'IDENTITY_EMAIL';
    if (data.email !== expectedEmail || claims.email !== expectedEmail) throw new Error();
    reason = 'IDENTITY_PROVIDER';
    if (claims.firebase?.sign_in_provider !== 'password') throw new Error();
    reason = 'IDENTITY_TIME';
    if (!Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 300) throw new Error();
    return { uid };
  } catch { throw new AuthProviderError('UNAVAILABLE', { operation, status, reason }); }
}

function firebaseAuth(config) {
  let signingKey, accessToken, tokenExpires = 0, pendingToken;
  async function mintAccessToken() {
    try {
      if (!signingKey) {
        const pem = config.privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
        const bytes = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
        signingKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        if (signingKey.algorithm.modulusLength < 2048) { signingKey = undefined; throw new Error(); }
      }
    } catch { throw new AuthProviderError('NOT_CONFIGURED'); }
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', ...(config.keyId ? { kid: config.keyId } : {}) };
    const claims = { iss: config.email, scope: OAUTH_SCOPE, aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 };
    const unsigned = `${encodeJson(header)}.${encodeJson(claims)}`;
    let signature;
    try { signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(unsigned)); }
    catch { throw new AuthProviderError('NOT_CONFIGURED'); }
    const { data } = await requestJson(TOKEN_ENDPOINT, new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}`,
    }), 'oauth');
    const duration = Number(data.expires_in);
    if (typeof data.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{1,8192}=*$/.test(data.access_token)
      || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new AuthProviderError('UNAVAILABLE');
    accessToken = data.access_token; tokenExpires = Date.now() + duration * 1000;
    return accessToken;
  }
  async function oauthToken() {
    if (accessToken && tokenExpires > Date.now() + 60000) return accessToken;
    if (!pendingToken) pendingToken = mintAccessToken().finally(() => { pendingToken = undefined; });
    return pendingToken;
  }
  async function authenticate(operation, username, password) {
    const email = alias(username), checked = passwordValue(password);
    const endpoint = operation === 'create' ? 'signUp' : 'signInWithPassword';
    const { data, status } = await requestJson(`${IDENTITY_ORIGIN}/v1/accounts:${endpoint}?key=${encodeURIComponent(config.apiKey)}`,
      { email, password: checked, returnSecureToken: true }, operation);
    return receivedIdentity(data, email, config.projectId, operation, status);
  }
  return Object.freeze({
    createUser({ username, password }) { return authenticate('create', username, password); },
    verifyPassword({ username, password }) { return authenticate('verify', username, password); },
    async setPassword({ uid, password }) {
      const localId = uidValue(uid), checked = passwordValue(password);
      const { data } = await requestJson(`${IDENTITY_ORIGIN}/v1/projects/${config.projectId}/accounts:update`,
        { localId, password: checked }, 'update', await oauthToken());
      if (data.localId !== localId) throw new AuthProviderError('UNAVAILABLE');
    },
    async deleteUser({ uid }) {
      await requestJson(`${IDENTITY_ORIGIN}/v1/projects/${config.projectId}/accounts:delete`,
        { localId: uidValue(uid) }, 'delete', await oauthToken());
    },
  });
}
