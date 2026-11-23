#!/usr/bin/env node
/* Validate the model on disk with the same rules the app uses.
   Usage: node tools/validate.js [modelRoot]   (default: model)
   Exit code 1 if any errors; warnings do not fail the run. */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../app/model.js');

const root = process.argv[2] || 'model';
const SKIP = new Set(['project.json', 'team.json']);
const SKIP_DIR = new Set(['exports']);

let project = {};
try { project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') { console.error('error  project.json: ' + e.message); process.exit(1); } }
project = M.project(project);

const entries = [];
let unformatted = 0;
(function walk(dir) {
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) { if (!SKIP_DIR.has(rel)) walk(full); continue; }
    if (!name.endsWith('.json') || SKIP.has(rel)) continue;
    const raw = fs.readFileSync(full, 'utf8');
    const entry = { path: rel, data: null };
    try { entry.data = JSON.parse(raw); } catch (e) { entry.parseError = e.message; }
    if (entry.data && entry.data.id && M.typeOf(entry.data.id, project) && M.serialize(entry.data, project) !== raw) {
      unformatted++;
      console.log(`warn   ${name.replace(/\.json$/, '')}: file is not in canonical format (key order / indent)`);
    }
    entries.push(entry);
  }
})(root);

const issues = M.validate(project, entries);
for (const i of issues) console.log(`${i.severity.padEnd(6)} ${i.id}: ${i.message}  [${i.owner}]`);
const errors = issues.filter(i => i.severity === 'error').length;
console.log(`\n${entries.length} items, ${errors} errors, ${issues.length - errors + unformatted} warnings`);
process.exit(errors ? 1 : 0);
