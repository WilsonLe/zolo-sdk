import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('route evidence excludes unknown branches and external value declarations without executing fixture code', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'zalo-route-evidence-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, 'src'));
  await writeFile(join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/*.ts'] }));
  await writeFile(join(folder, 'outside.ts'), "export function outside() { return 'external' as const; }\nexport const record={segment:'external-record'} as const;\nexport const tuple=['external-tuple'] as const;\n");
  await writeFile(join(folder, 'src/routes.ts'), `
import { outside, record, tuple } from '../outside';
declare const choice: boolean;
declare const externalString: string;
const finite = choice ? 'left' : 'right';
const valid = \`/api/\${finite}/valid\`;
const partial = \`/api/\${choice ? 'partial' : externalString}/conditional\`;
const config = choice ? {name:'partial'} : {name:externalString};
const property = \`/api/\${config.name}/property\`;
function helper() { if (choice) return 'partial'; return externalString; }
const call = \`/api/\${helper()}/helper\`;
const foreign = \`/api/\${outside()}/foreign\`;
const foreignRecord = \`/api/\${record['segment']}/foreign-record\`;
const foreignTuple = \`/api/\${tuple[0]}/foreign-tuple\`;
function fallthrough() { if (choice) return 'partial'; }
function bareReturn() { if (choice) return 'partial'; return; }
const fallthroughPath = \`/api/\${fallthrough()}/fallthrough\`;
const barePath = \`/api/\${bareReturn()}/bare\`;
const dispatch = {one:{path:'first'},two:{path:'second'}} as const;
declare const key:keyof typeof dispatch;
const spec = dispatch[key];
const mapped = \`/api/\${spec.path}/mapped\`;
throw new Error('The route checker must never execute this fixture');
`);
  const { stdout } = await execute(process.execPath, [join(root, 'scripts/desktop-sdk-route-evidence.mjs'), folder], { timeout: 10000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(Object.keys(result).sort(), ['/api/first/mapped', '/api/left/valid', '/api/right/valid', '/api/second/mapped']);
  assert.ok(result['/api/left/valid'].expression.some(source => source.startsWith('src/routes.ts:')));
});
