/* Shared model rules: used by the browser app and by tools/validate.js (Node).
   No dependencies. Loaded as a classic script in the browser, require()d in Node. */
(function (root) {
  'use strict';

  var DEFAULT_PROJECT = {
    name: 'Untitled project',
    levels: [
      { key: 'STK', name: 'Stakeholder', parent: null },
      { key: 'USER', name: 'User', parent: 'STK' },
      { key: 'SYS', name: 'System', parent: 'USER' }
    ],
    statuses: ['draft', 'review', 'approved', 'obsolete'],
    priorities: ['must', 'should', 'could'],
    verification: ['test', 'analysis', 'inspection', 'demonstration']
  };

  var KEY_ORDER = ['id', 'title', 'text', 'rationale', 'source', 'status', 'priority', 'verification', 'traces'];
  var OPTIONAL = ['rationale', 'source', 'verification'];

  function project(p) {
    var out = {};
    for (var k in DEFAULT_PROJECT) out[k] = (p && p[k] != null) ? p[k] : DEFAULT_PROJECT[k];
    return out;
  }

  function levelOf(id) { return String(id).split('-')[0]; }

  function reqPath(modelRoot, id) {
    return modelRoot + '/requirements/' + levelOf(id) + '/' + id + '.json';
  }

  /* Canonical file text: fixed key order, 2-space indent, trailing newline.
     Stable output keeps git diffs to the fields that actually changed. */
  function serialize(data) {
    var out = {};
    KEY_ORDER.forEach(function (k) {
      var v = data[k];
      if (v == null) return;
      if (OPTIONAL.indexOf(k) >= 0 && v === '') return;
      if (k === 'traces') { if (!v.length) return; v = v.slice().sort(); }
      out[k] = v;
    });
    Object.keys(data).sort().forEach(function (k) {
      if (!(k in out) && KEY_ORDER.indexOf(k) < 0) out[k] = data[k];
    });
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* entries: [{ file: 'STK-001.json', dir: 'STK', data: {...} | null, parseError: string? }]
     returns:  [{ severity: 'error' | 'warn', id, code, message }] */
  function validate(proj, entries) {
    proj = project(proj);
    var issues = [];
    var levels = {};
    proj.levels.forEach(function (l) { levels[l.key] = l; });
    var hasChild = {};
    proj.levels.forEach(function (l) { if (l.parent) hasChild[l.parent] = true; });

    function add(severity, id, code, message) {
      issues.push({ severity: severity, id: id, code: code, message: message });
    }

    var byId = {};
    entries.forEach(function (e) {
      e._id = e.file.replace(/\.json$/, '');
      if (e.data) byId[e._id] = e;
    });

    var covered = {};
    entries.forEach(function (e) {
      var id = e._id, d = e.data;
      if (!d) { add('error', id, 'parse', 'File is not valid JSON: ' + (e.parseError || 'parse error')); return; }
      if (typeof d !== 'object' || Array.isArray(d)) { add('error', id, 'schema', 'File must contain a JSON object.'); return; }

      var lvl = levels[e.dir];
      if (!lvl) add('error', id, 'level', 'Folder "' + e.dir + '" is not a level defined in project.json.');
      if (d.id !== id) add('error', id, 'id-file', 'Field id "' + d.id + '" does not match file name.');
      if (!new RegExp('^' + e.dir + '-\\d{3,}$').test(id)) add('error', id, 'id-format', 'ID must look like ' + e.dir + '-001 and live in the ' + e.dir + ' folder.');

      if (!d.title || !String(d.title).trim()) add('error', id, 'title', 'Title is required.');
      if (!d.text || !String(d.text).trim()) add('error', id, 'text', 'Requirement statement is required.');
      else if (!/\bshall\b/i.test(d.text)) add('warn', id, 'shall', 'Statement has no "shall".');

      if (proj.statuses.indexOf(d.status) < 0) add('error', id, 'status', 'Status must be one of: ' + proj.statuses.join(', ') + '.');
      if (proj.priorities.indexOf(d.priority) < 0) add('error', id, 'priority', 'Priority must be one of: ' + proj.priorities.join(', ') + '.');
      if (d.verification != null && d.verification !== '' && proj.verification.indexOf(d.verification) < 0)
        add('error', id, 'verification', 'Verification must be one of: ' + proj.verification.join(', ') + '.');
      if (lvl && !hasChild[lvl.key] && !d.verification && d.status !== 'obsolete')
        add('warn', id, 'no-verification', 'No verification method set.');

      var traces = d.traces == null ? [] : d.traces;
      if (!Array.isArray(traces)) { add('error', id, 'traces', 'traces must be a list of IDs.'); traces = []; }
      if (!lvl) return;
      if (!lvl.parent) {
        if (traces.length) add('error', id, 'trace-top', 'Top-level requirements cannot trace upward.');
        return;
      }
      var seen = {};
      traces.forEach(function (t) {
        if (seen[t]) add('warn', id, 'trace-dup', 'Duplicate trace to ' + t + '.');
        seen[t] = true;
        if (!byId[t]) add('error', id, 'trace-dangling', 'Traces to ' + t + ', which does not exist.');
        else if (byId[t].dir !== lvl.parent) add('error', id, 'trace-level', 'Traces to ' + t + '; ' + lvl.key + ' requirements must trace to ' + lvl.parent + '.');
        else {
          if (d.status !== 'obsolete') covered[t] = true;
          if (byId[t].data.status === 'obsolete' && d.status !== 'obsolete')
            add('warn', id, 'trace-obsolete', 'Traces to ' + t + ', which is obsolete.');
        }
      });
      if (!traces.length && d.status !== 'obsolete') add('warn', id, 'orphan', 'Does not trace to any ' + lvl.parent + ' requirement.');
    });

    entries.forEach(function (e) {
      var d = e.data, lvl = levels[e.dir];
      if (!d || !lvl || !hasChild[lvl.key] || d.status === 'obsolete') return;
      if (!covered[e._id]) add('warn', e._id, 'uncovered', 'No lower-level requirement traces to this.');
    });

    var rank = { error: 0, warn: 1 };
    issues.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return issues;
  }

  var api = { DEFAULT_PROJECT: DEFAULT_PROJECT, project: project, levelOf: levelOf, reqPath: reqPath, serialize: serialize, validate: validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
