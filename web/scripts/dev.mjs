// Development preview only. Never included in the Cloudflare Pages Functions bundle.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../server/api.mjs';
import { createTestDatabase } from '../tests/sqlite-d1.mjs';
import { createDevelopmentAuth } from '../dev/password-auth.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(web, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
const database = await createTestDatabase(join(local, 'preview.sqlite'));
const developmentAuth = createDevelopmentAuth(join(local, 'password-auth.sqlite'));
const env = { DB: database.binding, AUTH: developmentAuth.auth, BOOTSTRAP_TOKEN: randomBytes(32).toString('base64url') };
const keyFile = join(local, 'preview-identities.json');
const seedOrigin = 'https://preview-seed.invalid';

async function api(method, path, body, cookie = '') {
  const headers = new Headers({ 'X-JinSling-Request': '1', 'Origin': seedOrigin, 'CF-Connecting-IP': '127.0.0.1' });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  const request = new Request(seedOrigin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleApi(request, env, {});
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(`Preview seed ${method} ${path}: ${json.error?.code || response.status}`);
  return { data: json.data, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}

let preview;
try { preview = JSON.parse(await readFile(keyFile, 'utf8')); } catch { preview = { accounts: [] }; }
async function savePreview() {
  await writeFile(keyFile, JSON.stringify(preview, null, 2), { mode: 0o600 });
}

if (!preview.accounts.length) {
  const status = await api('GET', '/api/session');
  if (status.data.configured) {
    throw new Error('Preview database exists without its local preview identities. Restore the preview identities file or explicitly reset this development-only database.');
  }
  const credentials = { username: 'owner_demo', password: randomBytes(32).toString('base64url') };
  // Persist only synthetic credentials before the call, so interruption after a
  // successful create does not lose the development account's login details.
  preview.accounts.push({ name: '사장님 체험', role: 'admin', ...credentials, setup_pending: true });
  await savePreview();
}

const sampleMembers = [
  { name: '김하늘 체험', phone: '01000000002', username: 'haneul_demo', approve: true },
  { name: '이서준 체험', phone: '01000000003', username: 'seojun_demo', approve: true },
  { name: '승인 대기 체험', phone: '01000000004', username: 'pending_demo', approve: false },
];
const credentialsFor = account => ({ username: account.username, password: account.password });
for (const account of preview.accounts) {
  if (account.setup_pending && account.role === 'admin') {
    const status = await api('GET', '/api/session');
    const session = status.data.configured
      ? await api('POST', '/api/auth/login', credentialsFor(account))
      : await api('POST', '/api/bootstrap', {
        setup_token: env.BOOTSTRAP_TOKEN, name: account.name, phone: '01000000001', ...credentialsFor(account),
      });
    account.id = session.data.user.id;
    delete account.setup_pending;
    await savePreview();
  }
  if (!account.login_key) continue;
  account.username ||= account.role === 'admin' ? 'owner_demo'
    : sampleMembers.find(sample => sample.name === account.name)?.username || `demo_${randomBytes(5).toString('hex')}`;
  account.password ||= randomBytes(32).toString('base64url');
  await savePreview();
  // Preserve existing IDs and reservations. A completed conversion can resume
  // after a restart without attempting to revive the old login key.
  let converted;
  try { converted = await api('POST', '/api/auth/login', credentialsFor(account)); } catch {
    const legacy = await api('POST', '/api/auth/login', { login_key: account.login_key });
    converted = await api('POST', '/api/auth/setup-password', credentialsFor(account), legacy.cookie);
  }
  account.id = converted.data.user.id;
  delete account.login_key;
  await savePreview();
}

let admin = await api('POST', '/api/auth/login', credentialsFor(preview.accounts[0]));
for (const sample of sampleMembers) {
  let account = preview.accounts.find(item => item.name === sample.name);
  if (account && !account.setup_pending) continue;
  if (!account) {
    account = { name: sample.name, role: 'user', username: sample.username, password: randomBytes(32).toString('base64url'), setup_pending: true };
    preview.accounts.push(account);
    await savePreview();
  }
  let joined;
  try { joined = await api('POST', '/api/auth/login', credentialsFor(account)); } catch {
    joined = await api('POST', '/api/auth/join', { name: sample.name, phone: sample.phone, ...credentialsFor(account) });
  }
  account.id = joined.data.user.id;
  delete account.setup_pending;
  await savePreview();
  if (sample.approve) await api('PATCH', `/api/admin/users/${joined.data.user.id}`, { status: 'approved' }, admin.cookie);
}

if (!preview.seeded_booking) {
  const day = new Date(Date.now() + 9 * 3600000 + 2 * 86400000);
  if (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10);
  const member = await api('POST', '/api/auth/login', credentialsFor(preview.accounts[1]));
  await api('POST', '/api/bookings', { date, start_time: '10:00', memo: '가상 데이터로 예약 흐름을 확인해 보세요.' }, member.cookie);
  await api('POST', '/api/bookings', { date, start_time: '11:00', customer_name: '전화 예약 체험', phone: '01000000009', memo: '관리자가 등록한 가상 예약' }, admin.cookie);
  preview.seeded_booking = true;
  await savePreview();
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
function originFor(req) {
  let explicit = process.env.PREVIEW_ORIGIN;
  try { explicit ||= readFileSync(join(local, 'preview-origin'), 'utf8').trim(); } catch {}
  if (explicit) return new URL(explicit).origin;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}
async function send(res, response, httpPreview = false) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
  // The managed preview URL is HTTP. Only this synthetic-data dev adapter
  // translates its cookie; production keeps the Secure __Host cookie intact.
  const cookies = response.headers.getSetCookie().map(value => httpPreview
    ? value.replace(/^__Host-jinsling_session=/, 'jinsling_preview_session=').replace(/; Secure\b/, '')
    : value);
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, originFor(req));
    if (url.pathname === '/__preview/identities' && req.method === 'GET') {
      await send(res, Response.json({ ok: true, data: {
        accounts: preview.accounts.map(({ name, role, username, password }) => ({ name, role, username, password })),
        notice: '가상 데이터 미리보기 · 실제 매장 예약이 아닙니다.',
      } }, { headers: { 'Cache-Control': 'no-store' } }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { await send(res, new Response('Request too large', { status: 413 })); return; }
        chunks.push(chunk);
      }
      const httpPreview = url.protocol === 'http:';
      const headers = new Headers(req.headers);
      if (httpPreview) {
        const parts = (headers.get('Cookie') || '').split(';').map(part => part.trim());
        const demo = parts.find(part => part.startsWith('jinsling_preview_session='));
        headers.delete('Cookie');
        if (demo) headers.set('Cookie', demo.replace(/^jinsling_preview_session=/, '__Host-jinsling_session='));
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      await send(res, await handleApi(request, env, {}), httpPreview);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { await send(res, new Response('Method not allowed', { status: 405 })); return; }
    const publicDir = join(web, 'public');
    const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(publicDir, '.' + name);
    if (!file.startsWith(publicDir + sep) || !types[extname(file)]) { await send(res, new Response('Not found', { status: 404 })); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
      const bytes = await readFile(file);
      await send(res, new Response(req.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
      } }));
    } catch { await send(res, new Response('Not found', { status: 404 })); }
  } catch (error) {
    console.error('Development preview request failed:', error.name);
    if (!res.headersSent) await send(res, Response.json({ ok: false, error: { code: 'PREVIEW_ERROR', message: '미리보기 요청을 처리하지 못했습니다.' } }, { status: 500 }));
    else res.end();
  }
});
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = Number(process.env.PORT || (portArg >= 0 ? args[portArg + 1] : 3000));
server.listen(port, '0.0.0.0', () => console.log(`jinSling synthetic-data preview listening on port ${port}.`));
function shutdown() { server.close(() => { developmentAuth.close(); database.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
