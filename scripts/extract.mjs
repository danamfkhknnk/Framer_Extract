#!/usr/bin/env node
/**
 * Playwright extract CLI — mirror satu website ke folder di ROOT project.
 *
 * Usage:
 *   pnpm extract <url> [options]
 *   node scripts/extract.mjs <url> [options]
 *
 * Contoh:
 *   pnpm extract https://orange-property-949925.framer.app
 *   pnpm extract https://mysite.framer.website --max-depth 2
 *   pnpm extract https://mysite.framer.website --out ./my-export
 *
 * Hasil default: ./<hostname>-export/  (di root project)
 */
import fs from 'fs';
import path from 'path';
import { mirrorSite } from '../src/server/browser-mirror.js';

function printHelp() {
  console.log(`
ExportNoCode — Playwright Extract

Usage:
  pnpm extract <url> [options]

Argumen:
  <url>                  URL lengkap yang mau di-mirror (wajib, diawali http:// atau https://)

Options:
  --out <dir>            Folder output. Default: ./<hostname>-export/ di root project
  --max-depth <n>        Kedalaman crawl link internal. Default: 2
  --timeout <ms>         Timeout per halaman (ms). Default: 30000
  --allowed <h1,h2>      Host tambahan yang diizinkan, dipisah koma
  -h, --help             Tampilkan bantuan ini

Contoh:
  pnpm extract https://orange-property-949925.framer.app
  pnpm extract https://mysite.framer.website --max-depth 1 --out ./mysite-export
`);
}

function parseArgs(argv) {
  const opts = {
    url: null,
    out: null,
    maxDepth: 2,
    perPageTimeoutMs: 30000,
    allowedHosts: null,
  };
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--out') {
      opts.out = args[++i];
    } else if (a.startsWith('--out=')) {
      opts.out = a.slice('--out='.length);
    } else if (a === '--max-depth') {
      opts.maxDepth = Number(args[++i]);
    } else if (a.startsWith('--max-depth=')) {
      opts.maxDepth = Number(a.slice('--max-depth='.length));
    } else if (a === '--timeout') {
      opts.perPageTimeoutMs = Number(args[++i]);
    } else if (a.startsWith('--timeout=')) {
      opts.perPageTimeoutMs = Number(a.slice('--timeout='.length));
    } else if (a === '--allowed') {
      opts.allowedHosts = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--allowed=')) {
      opts.allowedHosts = a.slice('--allowed='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (!a.startsWith('-') && !opts.url) {
      opts.url = a;
    } else {
      console.error(`Argumen tidak dikenal: ${a}\n`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.url) {
  console.error('Error: URL wajib diisi.\n');
  printHelp();
  process.exit(1);
}
if (!opts.url.startsWith('http://') && !opts.url.startsWith('https://')) {
  console.error('Error: URL harus diawali http:// atau https://');
  process.exit(1);
}
let hostname;
try {
  hostname = new URL(opts.url).hostname;
} catch {
  console.error('Error: URL tidak valid.');
  process.exit(1);
}

// Default output: ./<hostname>-export di ROOT project (cwd saat pnpm dijalankan)
const outDir = path.resolve(process.cwd(), opts.out ?? `./${hostname}-export`);

console.log('▶ Playwright extract mulai');
console.log(`  URL      : ${opts.url}`);
console.log(`  Output   : ${outDir}`);
console.log(`  Max depth: ${opts.maxDepth}`);
console.log(`  Timeout  : ${opts.perPageTimeoutMs}ms`);
if (opts.allowedHosts) console.log(`  Allowed  : ${opts.allowedHosts.join(', ')}`);
console.log('');

const started = Date.now();
try {
  const result = await mirrorSite(opts.url, outDir, {
    maxDepth: opts.maxDepth,
    perPageTimeoutMs: opts.perPageTimeoutMs,
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const files = fs.readdirSync(outDir);
  console.log('');
  console.log(`✔ Selesai dalam ${secs}s`);
  console.log(`  Halaman dikunjungi : ${result.pagesVisited}`);
  console.log(`  Resource tersimpan : ${result.resourcesCaptured}`);
  console.log(`  HTML di-rewrite    : ${result.documentsRewritten}`);
  console.log(`  Folder hasil       : ${outDir}`);
  console.log(`  Isi (${files.length}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', ...' : ''}`);
  console.log('');
  console.log('Cara lihat hasil:');
  console.log(`  npx serve "${outDir}"   # lalu buka http://localhost:3000`);
} catch (err) {
  console.error('✘ Extract gagal:', err?.message ?? err);
  process.exit(1);
}
