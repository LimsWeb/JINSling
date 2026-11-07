import {build} from 'esbuild';
import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dist=join(root,'dist');
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
await cp(join(root,'public'),dist,{recursive:true});
await build({entryPoints:[join(root,'src/worker.mjs')],outfile:join(dist,'_worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'none'});
await writeFile(join(dist,'_routes.json'),JSON.stringify({version:1,include:['/api/*'],exclude:[]},null,2)+'\n');
await writeFile(join(dist,'_headers'),[
  '/*',
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Cache-Control: no-store',
  '  X-Robots-Tag: noindex, nofollow','',
].join('\n'));
await writeFile(join(dist,'robots.txt'),'User-agent: *\nDisallow: /\n');
console.log('Built independent AI lab Pages upload in ai-lab/dist. No production assets or credentials included.');
