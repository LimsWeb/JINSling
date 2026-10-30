import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(web, 'public');
const target = join(web, 'dist');
for (const name of ['index.html', 'app.js', 'style.css']) {
  await readFile(join(source, name));
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await writeFile(join(target, '_routes.json'), JSON.stringify({
  version: 1,
  include: ['/api/*'],
  exclude: [],
}, null, 2) + '\n');
await writeFile(join(target, '_headers'), [
  '/*',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  X-Frame-Options: SAMEORIGIN',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
  '  Cache-Control: no-store',
  '  X-Robots-Tag: noindex, nofollow',
  '',
].join('\n'));
await writeFile(join(target, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
const files = await readdir(target);
console.log(`Built web/dist (${files.length} top-level files). Pages Functions stay in web/functions; D1 binding is DB.`);
