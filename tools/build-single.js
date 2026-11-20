#!/usr/bin/env node
/* Build one self-contained HTML file that can be emailed and opened from disk.
   It holds no data: it reads and writes the repository live through api.github.com.
   Usage: node tools/build-single.js [owner/repo] [outfile]   (default out: dist/strata.html) */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const repo = process.argv[2] || '';
const out = process.argv[3] || path.join(root, 'dist', 'strata.html');
if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('Repository must look like owner/name.'); process.exit(1); }
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let html = read('index.html');
const hashes = [];
html = html.replace(/<link rel="stylesheet" href="(app\/[^"]+)">/, (_, f) => `<style>\n${read(f)}</style>`);
html = html.replace(/<script src="(app\/[^"]+)"><\/script>/g, (_, f) => {
  const js = read(f).replace(/<\/script/gi, '<\\/script');
  hashes.push(`'sha256-${crypto.createHash('sha256').update(js).digest('base64')}'`);
  return `<script>${js}</script>`;
});
// Inline scripts are allowed only by their exact hash, so the page still cannot run anything else.
html = html.replace("script-src 'self'", 'script-src ' + hashes.join(' '));
if (repo) html = html.replace('<title>', `<meta name="se-repo" content="${repo}">\n<title>`);
if (/(href|src)="app\//.test(html) || hashes.length !== 2) { console.error('Could not inline every asset.'); process.exit(1); }

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB${repo ? '  preset: ' + repo : ''}`);
