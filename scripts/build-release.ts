/**
 * Release build: produces a single self-contained executable with Bun.
 *
 * Steps:
 *  1. Generate src/server/version.ts from the version in package.json
 *     (baked into the binary at compile time).
 *  2. Build the Vue client with Vite → dist/client.
 * 3. Compile the server to a single executable with `bun build --compile`,
 *     embedding dist/client via `--asset`. The binary reads it at runtime from
 *     Bun.embeddedFiles (see src/server/index.ts), so it serves the frontend
 *     without any external files.
 *
 * Usage: bun run scripts/build-release.ts   (or: npm run release)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { name: string; version: string };

console.log(`[release] Building ${pkg.name} v${pkg.version}`);

// 1. Generate the version module so the binary carries the current version
const versionFile = path.join(root, 'src/server/version.ts');
writeFileSync(versionFile, `// Generated from package.json by scripts/build-release.ts — do not edit manually.\nexport const APP_VERSION = ${JSON.stringify(pkg.version)};\n`);
console.log(`[release] Wrote ${path.relative(root, versionFile)} (v${pkg.version})`);

// 2. Build the client bundle
console.log('[release] Building client (vite)…');
execSync('npm run build:client', { cwd: root, stdio: 'inherit' });

// 3. Compile the single-file executable (--asset embeds dist/client into the
//    binary; at runtime it is exposed via Bun.embeddedFiles in src/server/index.ts)
const releaseDir = path.join(root, 'release');
mkdirSync(releaseDir, { recursive: true });
const outfile = path.join(releaseDir, pkg.name);
console.log('[release] Compiling executable (bun build --compile)…');
execSync(`bun build src/server/index.ts --compile --asset dist/client --outfile "${outfile}"`, { cwd: root, stdio: 'inherit' });

console.log(`\n[release] ✅ Done: ${path.relative(root, outfile)} (v${pkg.version})`);
console.log('[release] Run it with: ./release/' + pkg.name);
