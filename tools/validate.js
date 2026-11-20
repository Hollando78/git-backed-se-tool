#!/usr/bin/env node
/* Validate the requirements model on disk with the same rules the app uses.
   Usage: node tools/validate.js [modelRoot]   (default: model)
   Exit code 1 if any errors; warnings do not fail the run. */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../app/model.js');

const root = process.argv[2] || 'model';
const reqDir = path.join(root, 'requirements');

let project = {};
try { project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') { console.error('error  project.json: ' + e.message); process.exit(1); } }

const entries = [];
let unformatted = 0;
for (const dir of fs.existsSync(reqDir) ? fs.readdirSync(reqDir) : []) {
  const full = path.join(reqDir, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const file of fs.readdirSync(full).filter(f => f.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(full, file), 'utf8');
    const entry = { file, dir, data: null };
    try { entry.data = JSON.parse(raw); } catch (e) { entry.parseError = e.message; }
    if (entry.data && M.serialize(entry.data) !== raw) {
      unformatted++;
      console.log(`warn   ${file.replace(/\.json$/, '')}: file is not in canonical format (key order / indent)`);
    }
    entries.push(entry);
  }
}

const issues = M.validate(project, entries);
for (const i of issues) console.log(`${i.severity.padEnd(6)} ${i.id}: ${i.message}`);
const errors = issues.filter(i => i.severity === 'error').length;
console.log(`\n${entries.length} requirements, ${errors} errors, ${issues.length - errors + unformatted} warnings`);
process.exit(errors ? 1 : 0);
