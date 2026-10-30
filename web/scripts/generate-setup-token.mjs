import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const local = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
const file = resolve(local, 'setup-token.txt');
await writeFile(file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
console.log('A new setup token was saved privately to web/.local/setup-token.txt.');
console.log('Open that file on your computer; set its contents as the encrypted BOOTSTRAP_TOKEN secret in Cloudflare Pages.');
console.log('Do not commit or paste the token into chat. This command did not contact Cloudflare.');
