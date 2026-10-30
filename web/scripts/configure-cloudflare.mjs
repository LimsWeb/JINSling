import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const prompt = createInterface({ input: stdin, output: stdout });
try {
  const id = (await prompt.question('Cloudflare가 발급한 실제 D1 Database ID: ')).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Cloudflare 화면에 표시된 실제 Database ID를 입력해주세요.');
  }
  const name = (await prompt.question('D1 데이터베이스 이름 [jinsling-db]: ')).trim() || 'jinsling-db';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error('데이터베이스 이름을 확인해주세요.');
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');
  await writeFile(file, JSON.stringify({
    name: 'jinsling', pages_build_output_dir: './dist', compatibility_date: '2026-10-30',
    d1_databases: [{ binding: 'DB', database_name: name, database_id: id, migrations_dir: './migrations' }],
  }, null, 2) + '\n');
  console.log('Local CLI configuration saved to web/wrangler.jsonc. No cloud resource was changed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { prompt.close(); }
