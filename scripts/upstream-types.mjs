import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// zca-js 2.2.0's package type entry re-exports an extensionless directory.
// Copy its MIT-licensed declarations so NodeNext can resolve the actual index.
const upstream = dirname(dirname(fileURLToPath(import.meta.resolve('zca-js'))));
const output = fileURLToPath(new URL('../types/zca/', import.meta.url));
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(join(upstream, 'dist'), { recursive: true })) {
  if (!entry.endsWith('.d.ts')) continue;
  mkdirSync(dirname(join(output, entry)), { recursive: true });
  copyFileSync(join(upstream, 'dist', entry), join(output, entry));
}
copyFileSync(join(upstream, 'LICENSE'), join(output, 'LICENSE'));
