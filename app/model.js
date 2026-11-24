/* Shared model rules: used by the browser app and by tools/validate.js (Node).
   No dependencies. Loaded as a classic script in the browser, require()d in Node.

   ID coding:  <PROJECT>-<TYPE>-<NNNN>      e.g. HS-REQ-0006, HS-ASS-0001, HS-RSK-0005
     TYPE    PBS, a requirement level key (e.g. STK / USR / REQ), ASS, INT, VER, RSK or DEC.
   An ID is fixed when the item is created and never changes.

   Which system an item belongs to is an attribute (`system`), not part of the ID.
   Each PBS element carries an ISO 81346 reference designation (RDS-PS / RDS-CW) in `code`:
   one single-level designation per breakdown level, joined by dots, e.g. A1.BA1.KFA1.
   The tool enforces the structure (letters per level, numbering, parent prefix, uniqueness);
   the class-letter tables are licensed content and can be supplied in project.json (rds.classes). */
(function (root) {
  'use strict';

  var DEFAULT_PROJECT = {
    name: 'Untitled project',
    code: 'PRJ',
    levels: [
      { key: 'STK', name: 'Stakeholder', parent: null },
      { key: 'USR', name: 'User', parent: 'STK' },
      { key: 'REQ', name: 'System', parent: 'USR' }
    ],
    statuses: ['draft', 'review', 'approved', 'obsolete'],
    verification: ['test', 'analysis', 'inspection', 'demonstration'],
    objectTypes: ['requirement', 'information'],
    reqTypes: ['architecture', 'interface', 'functional', 'performance', 'system', 'implementation'],
    safetyClasses: ['SC1', 'SC2', 'SC3', 'N/A'],
    rds: { scheme: 'RDS-PS', aspect: '=', letters: [1, 2, 3], classes: [] },
    interfaceTypes: { Function: ['Energy', 'Material', 'Information'], Physical: ['Geometry', 'Clearance', 'Load Transfer'] },
    interfaceMaturity: ['Identified', 'RIBA 1', 'RIBA 2', 'RIBA 3', 'RIBA 4'],
    stabilities: ['stable', 'developing', 'unstable'],
    compliances: ['compliant', 'compliance risk', 'non-compliant'],
    likelihoodLabels: ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'],
    impactLabels: ['Negligible', 'Minor', 'Moderate', 'Major', 'Severe']
  };

  /* Item types other than requirements. `to` lists the type codes a link may point at;
     LEAF / REQS are placeholders resolved against the project's requirement levels. */
  var TYPES = {
    PBS: { name: 'System', plural: 'Systems (PBS)', dir: 'components', fields: [
      { k: 'code', label: 'RDS code', type: 'text', req: true, fixed: true },
      { k: 'title', label: 'System name', type: 'text', req: true },
      { k: 'description', label: 'Description', type: 'area' },
      { k: 'kind', label: 'Kind', type: 'select', req: true, opts: ['system', 'subsystem', 'hardware', 'software', 'external'] },
      { k: 'status', label: 'Control status', type: 'select', req: true, opts: ['proposed', 'approved'] },
      { k: 'safetyClass', label: 'Safety class', type: 'select', opts: 'safetyClasses' },
      { k: 'owner', label: 'System owner', type: 'text' },
      { k: 'company', label: 'Owner company', type: 'text' },
      { k: 'parent', label: 'Part of', type: 'link', to: ['PBS'] }
    ] },
    INT: { name: 'Interface', plural: 'Interfaces', dir: 'interfaces', fields: [
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'description', label: 'Description', type: 'area' },
      { k: 'rationale', label: 'Interface rationale', type: 'area' },
      { k: 'kind', label: 'Interface type', type: 'select', req: true, opts: 'interfaceTypes' },
      { k: 'subtype', label: 'Sub-type', type: 'select', req: true, opts: 'interfaceTypes' },
      { k: 'from', label: 'System A (from)', type: 'link', req: true, to: ['PBS'] },
      { k: 'to', label: 'System B (to)', type: 'link', req: true, to: ['PBS'] },
      { k: 'agreedFrom', label: 'Agreed by System A', type: 'select', req: true, opts: ['TBD', 'Yes', 'No'] },
      { k: 'agreedTo', label: 'Agreed by System B', type: 'select', req: true, opts: ['TBD', 'Yes', 'No'] },
      { k: 'maturity', label: 'Maturity', type: 'select', req: true, opts: 'interfaceMaturity' },
      { k: 'requirements', label: 'Requirements (of System A or B)', type: 'links', to: ['LEAF'] }
    ] },
    VER: { name: 'Verification case', plural: 'Verification cases', dir: 'verification', fields: [
      { k: 'system', label: 'System', type: 'link', req: true, to: ['PBS'] },
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'method', label: 'Method', type: 'select', req: true, opts: 'verification' },
      { k: 'procedure', label: 'Procedure and pass criteria', type: 'area' },
      { k: 'result', label: 'Result', type: 'select', req: true, opts: ['planned', 'passed', 'failed', 'blocked'] },
      { k: 'notes', label: 'Result notes', type: 'area' },
      { k: 'evidenceDoc', label: 'Evidence document', type: 'text' },
      { k: 'evidenceVersion', label: 'Evidence version', type: 'text' },
      { k: 'verifies', label: 'Verifies', type: 'links', to: ['LEAF'] }
    ] },
    RSK: { name: 'Risk', plural: 'Risks', dir: 'risks', fields: [
      { k: 'system', label: 'System', type: 'link', req: true, to: ['PBS'] },
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'cause', label: 'If (the system does, or fails to do, something)', short: 'If', type: 'area', req: true },
      { k: 'consequence', label: 'Then (the consequence)', short: 'Then', type: 'area', req: true },
      { k: 'likelihood', label: 'Likelihood', type: 'num', req: true, labels: 'likelihoodLabels' },
      { k: 'impact', label: 'Impact', type: 'num', req: true, labels: 'impactLabels' },
      { k: 'status', label: 'Status', type: 'select', req: true, opts: ['open', 'mitigating', 'accepted', 'impacting', 'closed'] },
      { k: 'mitigation', label: 'Mitigation', type: 'area' },
      { k: 'owner', label: 'Owner', type: 'text' },
      { k: 'requirements', label: 'Related requirements', type: 'links', to: ['LEAF'] }
    ] },
    DEC: { name: 'Decision', plural: 'Decisions', dir: 'decisions', fields: [
      { k: 'system', label: 'System', type: 'link', req: true, to: ['PBS'] },
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'context', label: 'Context', type: 'area', req: true },
      { k: 'options', label: 'Options considered', type: 'area' },
      { k: 'decision', label: 'Decision', type: 'area' },
      { k: 'status', label: 'Status', type: 'select', req: true, opts: ['proposed', 'accepted', 'superseded'] },
      { k: 'affects', label: 'Affects', type: 'links', to: ['REQS', 'PBS', 'INT'] }
    ] }
  };

  function project(p) {
    var out = {};
    for (var k in DEFAULT_PROJECT) out[k] = (p && p[k] != null) ? p[k] : DEFAULT_PROJECT[k];
    if (p) for (var j in p) if (!(j in out)) out[j] = p[j];
    return out;
  }

  function levelDef(proj, key) { for (var i = 0; i < proj.levels.length; i++) if (proj.levels[i].key === key) return proj.levels[i]; return null; }
  function leafKey(proj) {
    var parents = {};
    proj.levels.forEach(function (l) { if (l.parent) parents[l.parent] = true; });
    var leaf = proj.levels.filter(function (l) { return !parents[l.key]; })[0];
    return leaf ? leaf.key : null;
  }
  /* Raw type code. Short forms such as "RSK-000" are accepted so code can ask about a type before an ID exists. */
  function codeOf(id) { var p = String(id).split('-'); return p.length >= 3 ? p[p.length - 2] : p[0]; }
  /* The collection an item belongs to: assumptions live with the lowest requirement level. */
  function prefixOf(id, proj) { var c = codeOf(id); return c === 'ASS' ? leafKey(proj || DEFAULT_PROJECT) : c; }
  function makeId(proj, code, n) { return [proj.code, code, String(n).padStart(4, '0')].join('-'); }
  function typeOf(id, proj) {
    var p = prefixOf(id, proj);
    if (levelDef(proj, p)) return 'REQ';
    return TYPES[p] ? p : null;
  }
  /* The access-control unit: a folder under the model root. */
  function areaOf(id, proj) {
    var p = prefixOf(id, proj);
    return levelDef(proj, p) ? 'requirements/' + p : (TYPES[p] ? TYPES[p].dir : null);
  }
  function relPath(id, proj) { return areaOf(id, proj) + '/' + id + '.json'; }
  function isItemPath(rel, proj) {
    var m = rel.match(/^(.+)\/([^/]+)\.json$/);
    return !!m && areaOf(m[2], proj) === m[1];
  }

  function fields(id, proj) {
    var code = codeOf(id), p = prefixOf(id, proj), lvl = levelDef(proj, p), leaf = leafKey(proj), ass = code === 'ASS';
    var not = function (list, v) { return list.filter(function (x) { return x !== v; }); };
    var defs;
    if (lvl) {
      defs = [
        { k: 'system', label: 'System', type: 'link', req: true, to: ['PBS'] },
        { k: 'object', label: 'Object type', type: 'select', req: true, opts: ass ? ['assumption'] : not(proj.objectTypes, 'assumption') },
        { k: 'type', label: 'Requirement type', type: 'select', opts: 'reqTypes' },
        { k: 'title', label: 'Title', type: 'text', req: true },
        { k: 'text', label: ass ? 'Assumption' : 'Requirement', type: 'area', req: true },
        { k: 'rationale', label: ass ? 'Assumption rationale' : 'Requirement rationale', type: 'area' },
        { k: 'source', label: 'Source', type: 'text' },
        // An assumption is by definition not settled, so it can never be marked stable.
        { k: 'stability', label: 'Stability', type: 'select', rag: true, opts: ass ? not(proj.stabilities, proj.stabilities[0]) : 'stabilities' },
        { k: 'stabilityRationale', label: 'Stability rationale', type: 'area' },
        { k: 'status', label: 'Status', type: 'select', req: true, opts: 'statuses' },
        { k: 'compliance', label: 'Compliance status', type: 'select', rag: true, opts: 'compliances' },
        { k: 'complianceRationale', label: 'Compliance rationale', type: 'area' },
        { k: 'complianceEvidence', label: 'Compliance evidence', type: 'area' },
        { k: 'verification', label: 'Verification method', type: 'select', opts: 'verification' }
      ];
      if (lvl.parent) defs.push({ k: 'traces', label: 'Traces to (' + lvl.parent + ')', type: 'links', to: [lvl.parent] });
    } else defs = TYPES[p] ? TYPES[p].fields : [];
    return defs.map(function (f) {
      var o = {}; for (var k in f) o[k] = f[k];
      if (typeof o.opts === 'string') o.opts = proj[o.opts];
      if (o.opts && !Array.isArray(o.opts)) {   // grouped options: the type is the group, the sub-type its members
        o.groups = o.opts;
        o.opts = f.k === 'kind' ? Object.keys(o.groups) : [].concat.apply([], Object.keys(o.groups).map(function (g) { return o.groups[g]; }));
      }
      if (typeof o.labels === 'string') o.labels = proj[o.labels];
      if (o.to) {
        var to = [];
        o.to.forEach(function (t) {
          if (t === 'LEAF') to.push(leaf);
          else if (t === 'REQS') proj.levels.forEach(function (l) { to.push(l.key); });
          else to.push(t);
        });
        o.to = to;
      }
      return o;
    });
  }

  function isEmpty(v) { return v == null || v === '' || (Array.isArray(v) && !v.length); }

  /* Canonical file text: id first, then fields in schema order, 2-space indent, trailing newline.
     Stable output keeps git diffs to the fields that actually changed. */
  function serialize(data, proj) {
    proj = project(proj);
    var out = { id: data.id };
    fields(data.id, proj).forEach(function (f) {
      var v = data[f.k];
      if (isEmpty(v)) return;
      out[f.k] = f.type === 'links' ? v.slice().sort() : v;
    });
    Object.keys(data).sort().forEach(function (k) {
      if (!(k in out) && !isEmpty(data[k])) out[k] = data[k];
    });
    return JSON.stringify(out, null, 2) + '\n';
  }

  /* entries: [{ path: 'requirements/STK/HS-HSS-STK-0001.json', data: {...} | null, parseError: string? }]
     returns:  [{ severity: 'error' | 'warn', id, code, message }] */
  function validate(proj, entries) {
    proj = project(proj);
    var issues = [], byId = {}, leaf = leafKey(proj), systems = {};
    var hasChildLevel = {};
    proj.levels.forEach(function (l) { if (l.parent) hasChildLevel[l.parent] = true; });
    var CATS = { meta: 'Missing metadata', check: 'Checking comment', orphan: 'Traceability', uncovered: 'Traceability', 'trace-obsolete': 'Traceability',
      'no-case': 'Verification', 'no-target': 'Verification', failed: 'Verification', 'no-verification': 'Missing metadata', issue: 'Risk', unmitigated: 'Risk',
      'int-noreq': 'Interface', 'no-evidence': 'Compliance', 'evidence-ref': 'Compliance', 'no-comp-rationale': 'Compliance', 'no-stab-rationale': 'Missing metadata' };
    function add(severity, id, code, message) {
      issues.push({ severity: severity, id: id, code: code, message: message, cat: severity === 'error' ? 'Error' : (CATS[code.split(':')[0]] || 'Other') });
    }
    var idRe = new RegExp('^' + proj.code + '-[A-Z]+-\\d{4}$');
    /* RDS code of an item's system (its own code for a PBS element). */
    var sysOf = function (id) { var e = byId[id]; if (!e) return ''; if (codeOf(id) === 'PBS') return e.data.code || ''; return byId[e.data.system] ? (byId[e.data.system].data.code || '') : ''; };
    var depthOf = function (pbsId) { return sysOf(pbsId).split('.').length - 1; };
    // A document reference needs a number (e.g. HS-TR-0012) and a version (e.g. v1.2, Rev B, Issue 3).
    var DOC_NO = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2,}\b|\b[A-Z]{2,}\d{3,}\b/, DOC_VER = /\b(?:v\.?\s*\d[\d.]*|(?:ver|version|rev|revision|issue|iss)\.?\s*[0-9A-Z][\d.]*)\b/i;

    entries.forEach(function (e) {
      e._id = e.path.replace(/^.*\//, '').replace(/\.json$/, '');
      if (e.data && typeof e.data === 'object' && !Array.isArray(e.data)) {
        byId[e._id] = e;
        if (codeOf(e._id) === 'PBS') {
          if (systems[sysOf(e._id)]) add('error', e._id, 'dup-code', 'System code ' + sysOf(e._id) + ' is already used by ' + systems[sysOf(e._id)]._id + '.');
          else systems[sysOf(e._id)] = e;
        }
      }
    });

    var covered = {}, verified = {}, anyVer = false;
    entries.forEach(function (e) {
      var id = e._id, d = e.data;
      if (!d) { add('error', id, 'parse', 'File is not valid JSON: ' + (e.parseError || 'parse error')); return; }
      if (!byId[id]) { add('error', id, 'schema', 'File must contain a JSON object.'); return; }
      var type = typeOf(id, proj);
      if (!type) { add('error', id, 'type', 'Type code "' + codeOf(id) + '" is not a known item type.'); return; }
      if (!idRe.test(id)) add('error', id, 'id-format', 'ID must look like ' + makeId(proj, codeOf(id), 1) + '.');
      if (e.path !== relPath(id, proj)) add('error', id, 'path', 'File should be at ' + relPath(id, proj) + '.');
      if (d.id !== id) add('error', id, 'id-file', 'Field id "' + d.id + '" does not match file name.');

      fields(id, proj).forEach(function (f) {
        var v = d[f.k];
        if (isEmpty(v)) { if (f.req) add('error', id, f.k, (f.short || f.label) + ' is required.'); return; }
        if (f.type === 'select' && f.opts.indexOf(v) < 0) add('error', id, f.k, f.label + ' must be one of: ' + f.opts.join(', ') + '.');
        if (f.type === 'num' && !(v === Math.floor(v) && v >= 1 && v <= 5)) add('error', id, f.k, f.label + ' must be a whole number from 1 to 5.');
        if (f.type === 'links' && !Array.isArray(v)) { add('error', id, f.k, f.label + ' must be a list of IDs.'); return; }
        if (f.type === 'link' || f.type === 'links') {
          var seen = {};
          (f.type === 'link' ? [v] : v).forEach(function (t) {
            if (seen[t]) add('warn', id, 'trace-dup', 'Duplicate link to ' + t + '.');
            seen[t] = true;
            if (!byId[t]) add('error', id, 'trace-dangling', f.label + ': ' + t + ' does not exist.');
            else if (f.to.indexOf(prefixOf(t, proj)) < 0) add('error', id, 'trace-level', f.label + ': ' + t + ' is not allowed here (expects ' + f.to.join(' or ') + ').');
          });
        }
      });

      // Open checking comments are tasks until someone closes them.
      if (Array.isArray(d.checks)) d.checks.forEach(function (c) {
        if (c && !c.closedBy) add('warn', id, 'check', 'Checking comment from ' + c.by + ' (' + String(c.date).slice(0, 10) + '): ' + c.text);
      });
      var links = function (k) { return Array.isArray(d[k]) ? d[k].filter(function (t) { return byId[t]; }) : []; };
      if (type === 'REQ') {
        var lvl = levelDef(proj, prefixOf(id, proj)), isReq = d.object === 'requirement';
        if (isReq && d.text && !/\bshall\b/i.test(d.text)) add('warn', id, 'shall', 'Requirement has no "shall".');
        if (isReq && lvl.key === leaf && !d.verification && d.status !== 'obsolete') add('warn', id, 'no-verification', 'No verification method set.');
        if (d.compliance === proj.compliances[0] && isEmpty(d.complianceEvidence)) add('warn', id, 'no-evidence', 'Marked compliant with no compliance evidence.');
        if (!isEmpty(d.complianceEvidence) && !(DOC_NO.test(d.complianceEvidence) && DOC_VER.test(d.complianceEvidence))) add('warn', id, 'evidence-ref', 'Compliance evidence does not cite a document number and version (for example HS-TR-0012 v1.0).');
        if (d.compliance && d.compliance !== proj.compliances[0] && isEmpty(d.complianceRationale)) add('warn', id, 'no-comp-rationale', 'Not compliant, but no compliance rationale is given.');
        if (d.stability === proj.stabilities[proj.stabilities.length - 1] && isEmpty(d.stabilityRationale)) add('warn', id, 'no-stab-rationale', 'Marked ' + d.stability + ' with no stability rationale.');
        var need = d.object === 'requirement' ? ['type', 'rationale', 'source', 'stability', 'compliance'] : d.object === 'assumption' ? ['rationale', 'source', 'stability'] : [];
        if (d.status !== 'obsolete') fields(id, proj).forEach(function (f) {
          if (need.indexOf(f.k) >= 0 && isEmpty(d[f.k])) add('warn', id, 'meta:' + f.k, f.label + ' is not filled in.');
        });
        if (!lvl.parent) { if (!isEmpty(d.traces)) add('error', id, 'trace-top', 'Top-level requirements cannot trace upward.'); return; }
        links('traces').forEach(function (t) {
          if (d.status !== 'obsolete') covered[t] = true;
          if (byId[t].data.status === 'obsolete' && d.status !== 'obsolete') add('warn', id, 'trace-obsolete', 'Traces to ' + t + ', which is obsolete.');
        });
        if (isReq && isEmpty(d.traces) && d.status !== 'obsolete') add('warn', id, 'orphan', 'Does not trace to any ' + lvl.parent + ' requirement.');
      } else if (type === 'PBS') {
        if (d.parent === id) add('error', id, 'parent', 'A system cannot be part of itself.');
        // ISO 81346 structure: one designation per level, each <letters><number>, extending the parent's code.
        var segs = String(d.code || '').split('.'), want = byId[d.parent] ? sysOf(d.parent) : '';
        segs.forEach(function (seg, i) {
          var n = proj.rds.letters[Math.min(i, proj.rds.letters.length - 1)];
          if (!new RegExp('^[A-Z]{' + n + '}[1-9]\\d*$').test(seg)) add('error', id, 'rds', proj.rds.scheme + ' code: level ' + i + ' must be ' + n + ' class letter' + (n > 1 ? 's' : '') + ' and a number, got "' + seg + '".');
          else if (proj.rds.classes[i] && proj.rds.classes[i].length && proj.rds.classes[i].indexOf(seg.replace(/\d+$/, '')) < 0) add('error', id, 'rds-class', proj.rds.scheme + ' code: "' + seg.replace(/\d+$/, '') + '" is not a class allowed at level ' + i + '.');
        });
        if (segs.slice(0, -1).join('.') !== want) add('error', id, 'rds-parent', proj.rds.scheme + ' code must extend its parent\'s code' + (want ? ' (' + want + '.…)' : ' (a top-level system has a single designation)') + '.');
      } else if (type === 'INT') {
        if (d.from && d.from === d.to) add('error', id, 'self', 'An interface needs two different systems.');
        var fa = byId[d.from], fb = byId[d.to];
        if (fa && fb && codeOf(d.from) === 'PBS' && codeOf(d.to) === 'PBS') {
          if (depthOf(d.from) !== depthOf(d.to)) add('error', id, 'int-level', 'An interface can only join systems at the same architectural level (' + sysOf(d.from) + ' is level ' + depthOf(d.from) + ', ' + sysOf(d.to) + ' is level ' + depthOf(d.to) + ').');
          links('requirements').forEach(function (t) {
            if (sysOf(t) !== sysOf(d.from) && sysOf(t) !== sysOf(d.to)) add('error', id, 'int-req', t + ' belongs to neither System A nor System B.');
          });
        }
        if (d.kind && d.subtype && proj.interfaceTypes[d.kind] && proj.interfaceTypes[d.kind].indexOf(d.subtype) < 0) add('error', id, 'subtype', 'Sub-type "' + d.subtype + '" does not belong to interface type "' + d.kind + '".');
        if (isEmpty(d.requirements)) add('warn', id, 'int-noreq', 'Not linked to a requirement of either system.');
      } else if (type === 'VER') {
        anyVer = true;
        if (isEmpty(d.verifies)) add('warn', id, 'no-target', 'Does not verify any requirement.');
        if (d.result === 'failed') add('warn', id, 'failed', 'Verification failed.');
        links('verifies').forEach(function (t) { verified[t] = true; });
      } else if (type === 'RSK') {
        var home = byId[d.system];
        if (home && home.data.status !== 'approved') add('error', id, 'uncontrolled', 'Risks can only be raised against an approved system; ' + sysOf(id) + ' is ' + (home.data.status || 'not approved') + '.');
        if (d.status === 'impacting') add('warn', id, 'issue', 'Risk is impacting: it is now an issue.');
        else if (d.likelihood * d.impact >= 12 && d.status === 'open' && isEmpty(d.mitigation)) add('warn', id, 'unmitigated', 'High risk is open with no mitigation recorded.');
      }
    });

    entries.forEach(function (e) {
      var d = e.data, id = e._id;
      if (!byId[id] || typeOf(id, proj) !== 'REQ' || d.status === 'obsolete' || d.object !== 'requirement') return;
      var key = prefixOf(id, proj);
      if (hasChildLevel[key] && !covered[id]) add('warn', id, 'uncovered', 'No lower-level requirement traces to this.');
      if (key === leaf && anyVer && d.status === 'approved' && !verified[id]) add('warn', id, 'no-case', 'Approved, but no verification case covers it.');
    });

    // Every task gets an owner: the owner of the item's system (System A for an interface),
    // falling back to the owner of the top-level system.
    var rootOwner = '';
    Object.keys(systems).sort().forEach(function (c) { if (!rootOwner && c.indexOf('.') < 0 && systems[c].data.owner) rootOwner = systems[c].data.owner; });
    issues.forEach(function (i) {
      var e = byId[i.id], sys = e && codeOf(i.id) === 'INT' && e.data.from ? sysOf(e.data.from) : sysOf(i.id), own = '';
      for (var c = sys; c && !own; c = c.indexOf('.') < 0 ? '' : c.slice(0, c.lastIndexOf('.'))) own = systems[c] && systems[c].data.owner || '';
      i.owner = own || rootOwner || 'Unassigned';
    });
    var rank = { error: 0, warn: 1 };
    issues.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return issues;
  }

  var api = { DEFAULT_PROJECT: DEFAULT_PROJECT, TYPES: TYPES, project: project, codeOf: codeOf, prefixOf: prefixOf, makeId: makeId, leafKey: leafKey,
    typeOf: typeOf, areaOf: areaOf, relPath: relPath, isItemPath: isItemPath, fields: fields, serialize: serialize, validate: validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SEModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
