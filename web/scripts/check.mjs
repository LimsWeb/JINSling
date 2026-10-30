import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function scripts(dir) {
  let files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || ['dist', 'node_modules'].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await scripts(path));
    else if (/\.(?:m?js)$/.test(item.name)) files.push(path);
  }
  return files;
}
const paths = await scripts(web);
let failed = false;
for (const path of paths) {
  const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (check.status !== 0) { console.error(relative(web, path), check.stderr); failed = true; }
}
const migration = await readFile(join(web, 'migrations', '0001_initial.sql'), 'utf8');
if (!migration.trim()) { console.error('Missing database schema.'); failed = true; }
if (failed) process.exitCode = 1;
else console.log(`Syntax checked ${paths.length} JavaScript files; migration present.`);
