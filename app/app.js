/* Strata — a hub of small systems-engineering apps backed by a GitHub repository.
   No server: the browser talks to api.github.com with the user's own token. */
(() => {
  'use strict';
  const API = 'https://api.github.com';
  const M = window.SEModel;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
  };

  const APPS = [
    { key: 'PBS', name: 'Architecture', blurb: 'Product breakdown: the systems every requirement, risk and decision belongs to.' },
    { key: 'INT', name: 'Interfaces', blurb: 'Interface register, by level, with an N² view of what connects to what.' },
    { key: 'REQ', name: 'Requirements', blurb: 'What stakeholders, users and the system must do, traced level to level.' },
    { key: 'VER', name: 'Verification', blurb: 'Verification cases, their results and requirement coverage.' },
    { key: 'RSK', name: 'Risks', blurb: 'Risks per system on a likelihood × impact map, with issues lit up.' },
    { key: 'DEC', name: 'Decisions', blurb: 'Design decisions, the options weighed and what they affect.' }
  ];
  const CATS = ['Error', 'Missing metadata', 'Checking comment', 'Traceability', 'Compliance', 'Verification', 'Interface', 'Risk', 'Other'];
  const RANK = { none: 0, read: 1, write: 2, own: 3 };
  const ACC_LABEL = { none: 'No access', read: 'Read only', write: 'Can edit', own: 'Owner' };
  const TEAM_COLORS = ['#2a7e88', '#b97612', '#6a5a9c', '#3d7a4f', '#b54848', '#4a5f6e', '#8a6d3b'];

  const S = {
    token: '', user: null, owner: '', repo: '', root: 'model', repoInfo: null,
    branches: [], branch: '', head: null, project: M.project(), commits: [],
    team: { teams: [], users: [], domain: 'example.invalid' }, persona: '',
    base: new Map(),   // id -> { path, rel, sha, data }  as committed at head
    bad: [],           // files that failed to parse
    work: new Map(),   // id -> data  (base + staged edits)
    view: 'hub', level: '', q: '', f: {}, spec: '', specDepth: 'all', zoom: 1, grid: ls.get('se.grid', {}), colsOpen: false, lastGrid: null, sel: null, dialog: null, stamp: null, frozen: null, exports: [], exportsSha: null, intLevel: '', mdim: 'system', hist: {}, loading: '', error: '', committing: false
  };

  /* ---------------- GitHub ---------------- */
  async function gh(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      let msg = j.message || r.statusText || 'Request failed';
      if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') msg = S.token ? 'GitHub rate limit reached. Wait a few minutes and reload.' : 'GitHub allows only 60 anonymous requests an hour and that is used up. Connect with a token (5,000 an hour), or try again in an hour.';
      if ((r.status === 403 || r.status === 429) && r.headers.get('retry-after')) msg = 'GitHub is asking us to slow down. Wait a minute and reload.';
      if (r.status === 404 && !S.token) msg = 'Not found. Private repositories need a token.';
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  }
  const R = () => `/repos/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;
  const encRef = b => b.split('/').map(encodeURIComponent).join('/');
  const webUrl = () => `https://github.com/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;
  const canPush = () => !S.frozen && !!(S.token && S.repoInfo && S.repoInfo.permissions && S.repoInfo.permissions.push);

  /* Reading the model. One file per item means dozens of files, so avoid one API call each:
     - with a token: a single GraphQL query returns every file's text;
     - without one (public repo): the tree comes from the API and file bodies from
       raw.githubusercontent.com, which does not count against the 60/hour anonymous API limit.
     Either way the blobs API remains as a fallback, a few requests at a time. */
  const cacheGet = sha => { try { return sessionStorage.getItem('se.blob:' + sha); } catch { return null; } };
  const cachePut = (sha, text) => { try { sessionStorage.setItem('se.blob:' + sha, text); } catch { /* ignore */ } };
  async function blobText(sha) {
    const b = await gh(`${R()}/git/blobs/${sha}`);
    return new TextDecoder().decode(Uint8Array.from(atob(b.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
  }
  async function pooled(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
  }
  async function readViaGraphQL(commit) {
    const blob = 'name type oid object { ... on Blob { text isTruncated } ';
    const query = `query($o:String!,$r:String!,$e:String!){ repository(owner:$o,name:$r){ object(expression:$e){ ... on Tree { entries { ${blob} ... on Tree { entries { ${blob} ... on Tree { entries { ${blob} } } } } } } } } } } }`;
    const r = await gh('/graphql', { method: 'POST', body: { query, variables: { o: S.owner, r: S.repo, e: `${commit}:${S.root}` } } });
    if (r.errors?.length) throw new Error(r.errors[0].message);
    const out = [];
    (function walk(entries, dir) {
      for (const e of entries || []) {
        if (e.type === 'tree') walk(e.object?.entries, dir + e.name + '/');
        else if (e.type === 'blob' && e.name.endsWith('.json')) out.push({ rel: dir + e.name, sha: e.oid, text: e.object && !e.object.isTruncated ? e.object.text : null });
      }
    })(r.data?.repository?.object?.entries, '');
    return out;
  }
  async function readViaTree(commit) {
    const tree = await gh(`${R()}/git/trees/${commit}?recursive=1`);
    const prefix = S.root + '/';
    return tree.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix) && e.path.endsWith('.json'))
      .map(e => ({ rel: e.path.slice(prefix.length), sha: e.sha, text: null }));
  }
  /* -> [{ rel, sha, text }] for every .json file under the model root at this commit */
  async function readModel(commit) {
    let files = null;
    if (S.token) files = await readViaGraphQL(commit).catch(() => null);
    if (!files) files = await readViaTree(commit);
    files.forEach(f => { if (f.text == null) f.text = cacheGet(f.sha); else cachePut(f.sha, f.text); });
    const raw = `https://raw.githubusercontent.com/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}/${commit}/`;
    await pooled(files.filter(f => f.text == null), 6, async f => {
      if (!S.token) {
        const r = await fetch(raw + encRef(`${S.root}/${f.rel}`)).catch(() => null);
        if (r && r.ok) f.text = await r.text();
      }
      if (f.text == null) f.text = await blobText(f.sha);
      cachePut(f.sha, f.text);
    });
    return files;
  }

  /* ---------------- session ---------------- */
  function loadToken() {
    try { return sessionStorage.getItem('se.token') || localStorage.getItem('se.token') || ''; } catch { return ''; }
  }
  function saveToken(token, remember) {
    try {
      sessionStorage.removeItem('se.token'); localStorage.removeItem('se.token');
      if (token) (remember ? localStorage : sessionStorage).setItem('se.token', token);
    } catch { /* ignore */ }
  }
  function guessRepo() {
    const p = new URLSearchParams(location.search);
    if (p.get('repo')) return p.get('repo');
    const preset = document.querySelector('meta[name="se-repo"]')?.content;   // baked into the single-file build
    if (preset) return preset;
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);   // GitHub Pages: owner.github.io/repo/
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg ? `${m[1]}/${seg}` : '';
  }

  async function connect(repoStr, root, wantBranch) {
    const m = String(repoStr).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)\/?$/);
    if (!m) throw new Error('Repository must look like owner/name.');
    S.owner = m[1]; S.repo = m[2]; S.root = (root || 'model').replace(/^\/+|\/+$/g, '');
    S.loading = 'Connecting to GitHub…'; S.error = ''; render();
    S.user = S.token ? await gh('/user') : null;
    S.repoInfo = await gh(R());
    S.branches = (await gh(`${R()}/branches?per_page=100`)).map(b => b.name);
    if (!S.branches.length) throw new Error('This repository has no branches yet.');
    const pick = [wantBranch, S.repoInfo.default_branch].find(b => b && S.branches.includes(b)) || S.branches[0];
    ls.set('se.cfg', { repo: `${S.owner}/${S.repo}`, root: S.root, branch: pick });
    S.persona = ls.get('se.persona', '');
    await loadBranch(pick);
  }

  async function loadBranch(branch) {
    S.branch = branch; S.loading = 'Reading ' + branch + '…'; S.sel = null; render(); renderDrawer();
    const cfg = ls.get('se.cfg', {}); cfg.branch = branch; ls.set('se.cfg', cfg);
    const ref = await gh(`${R()}/git/ref/heads/${encRef(branch)}`);
    S.head = { sha: ref.object.sha };
    const [all, commits] = await Promise.all([
      readModel(ref.object.sha),
      gh(`${R()}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(S.root)}&per_page=30`).catch(() => [])
    ]);
    ingest(all, true);
    S.frozen = null; S.stamp = null;
    S.commits = commits; S.hist = {};
    const draft = ls.get(draftKey(), {});
    for (const id in draft) draft[id] === null ? S.work.delete(id) : S.work.set(id, draft[id]);
    S.loading = '';
    fixView();
    render();
  }

  /* Turn the files of one commit into the in-memory model. */
  function ingest(all, live) {
    const readJson = (name, dflt) => {
      const f = all.find(x => x.rel === name);
      if (!f) return dflt;
      try { return JSON.parse(f.text); } catch { toast(name + ' is not valid JSON; using defaults.', true); return dflt; }
    };
    S.project = M.project(readJson('project.json', {}));
    const team = readJson('team.json', {});
    S.team = { teams: team.teams || [], users: team.users || [], domain: team.domain || 'example.invalid' };
    if (!S.team.users.some(u => u.login === S.persona)) S.persona = '';
    if (live) {   // the export register always reflects the branch tip, never an old baseline
      const reg = readJson('exports/register.json', []);
      S.exports = Array.isArray(reg) ? reg : [];
      S.exportsSha = all.find(x => x.rel === 'exports/register.json')?.sha || null;
    }
    S.base = new Map(); S.bad = [];
    all.filter(f => M.isItemPath(f.rel, S.project)).forEach(f => {
      const entry = { path: `${S.root}/${f.rel}`, rel: f.rel, sha: f.sha, data: null };
      try { entry.data = JSON.parse(f.text); } catch (e) { entry.parseError = e.message; }
      if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) S.base.set(f.rel.replace(/^.*\//, '').replace(/\.json$/, ''), entry);
      else S.bad.push(entry);
    });
    S.work = new Map([...S.base].map(([id, e]) => [id, clone(e.data)]));
  }
  /* Re-open a recorded export exactly as it was: same commit, same view, read-only. */
  async function openBaseline(entry) {
    S.dialog = null; S.sel = null; S.loading = `Loading baseline v${entry.version}…`; render(); renderDrawer();
    ingest(await readModel(entry.commit), false);
    const v = entry.view || {};
    Object.assign(S, { frozen: entry, view: v.view || 'hub', level: v.level || '', spec: v.spec || '', specDepth: v.specDepth || 'all', f: v.f || {}, q: v.q || '', intLevel: v.intLevel || '', loading: '' });
    if (v.gridKey) S.grid[v.gridKey] = { hidden: v.hidden, sort: v.sort };
    fixView(); render();
  }
  const b64 = str => { let bin = ''; new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin); };
  async function saveRegister(list, message) {
    const p = me(), body = { message, content: b64(JSON.stringify(list, null, 2) + '\n'), branch: S.branch };
    if (S.exportsSha) body.sha = S.exportsSha;
    if (p) body.author = { name: p.name, email: `${p.login}@${S.team.domain}` };
    const r = await gh(`${R()}/contents/${encRef(S.root + '/exports/register.json')}`, { method: 'PUT', body });
    S.exports = list; S.exportsSha = r.content.sha;
  }

  function signOut() {
    saveToken('', false); S.token = ''; S.user = null; S.repoInfo = null; S.sel = null;
    render(); renderDrawer();
  }

  /* ---------------- people and access (simulated) ---------------- */
  const me = () => S.team.users.find(u => u.login === S.persona) || null;
  const teamOf = u => S.team.teams.find(t => t.key === u.team) || { key: u.team, name: u.team, access: {} };
  const teamColor = key => TEAM_COLORS[Math.max(0, S.team.teams.findIndex(t => t.key === key)) % TEAM_COLORS.length];
  const initials = name => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (u, size = 26) => `<span class="av" style="background:${teamColor(u.team)};width:${size}px;height:${size}px;font-size:${Math.round(size * .4)}px" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;
  /* Access to one area (a folder under the model root). With no persona, access is whatever GitHub grants. */
  function acc(area) {
    const p = me();
    if (!p) return canPush() ? 'own' : 'read';
    return teamOf(p).access[area] || 'none';
  }
  const areas = () => [
    ...S.project.levels.map(l => ({ key: 'requirements/' + l.key, name: `${l.name} requirements`, short: l.key })),
    ...Object.entries(M.TYPES).map(([k, t]) => ({ key: t.dir, name: t.plural, short: k }))
  ];
  const appAreas = k => k === 'REQ' ? S.project.levels.map(l => 'requirements/' + l.key) : [M.TYPES[k].dir];
  const appAcc = k => appAreas(k).map(acc).sort((a, b) => RANK[b] - RANK[a])[0];
  const canSee = id => RANK[acc(M.areaOf(id, S.project))] >= 1;
  const canEdit = id => canPush() && RANK[acc(M.areaOf(id, S.project))] >= 2;
  const CHECKED = ['REQ', 'PBS'];   // types that carry checking comments
  const canComment = id => canPush() && canSee(id) && CHECKED.includes(T(id));
  const sansChecks = d => { const o = clone(d); delete o.checks; return o; };
  /* A change is refused unless the person may edit the item, or it only adds or closes checking comments. */
  const refused = c => !canEdit(c.id) && !(c.type === 'mod' && canComment(c.id) && ser(sansChecks(c.data)) === ser(sansChecks(c.before)));
  const whoAmI = () => me()?.name || S.user?.login || 'unknown';
  const openChecks = d => (d.checks || []).filter(c => !c.closedBy);
  const checkText = d => { const all = d.checks || [], o = openChecks(d), l = o[o.length - 1]; return o.length ? `${o.length} open · ${l.by}, ${String(l.date).slice(0, 10)}: ${l.text}` : all.length ? `${all.length} closed` : ''; };
  const canEditPrefix = p => canEdit(p + '-000');

  /* ---------------- model helpers ---------------- */
  const draftKey = () => `se.draft:${S.owner}/${S.repo}@${S.branch}`;
  const T = id => M.typeOf(id, S.project);
  const P = id => M.prefixOf(id, S.project);
  const level = key => S.project.levels.find(l => l.key === key);
  const leaf = () => M.leafKey(S.project);
  const idsOf = prefix => [...S.work.keys()].filter(id => P(id) === prefix && canSee(id)).sort();
  const get = id => S.work.get(id);
  /* Every item has one home system: the PBS element whose code is in its ID. */
  /* RDS code of the system an item belongs to (a PBS element's own code). */
  const sysOf = id => { const d = get(id) || S.base.get(id)?.data; if (!d) return ''; return M.codeOf(id) === 'PBS' ? d.code || '' : get(d.system)?.code || ''; };
  const sysEl = code => idsOf('PBS').find(p => sysOf(p) === code) || '';
  const elOf = id => sysEl(sysOf(id));
  const homed = (el, prefix) => idsOf(prefix).filter(i => sysOf(i) === sysOf(el));
  const sysLabel = id => { const e = elOf(id); return e ? `${sysOf(id)} · ${get(e).title}` : sysOf(id); };
  const shortId = id => id.startsWith(S.project.code + '-') ? id.slice(S.project.code.length + 1) : id;
  const chainOf = id => { const c = []; for (let x = id; x && S.work.has(x) && !c.includes(x); x = get(x).parent) c.unshift(x); return c; };
  const intLevel = (a, b) => { const A = chainOf(a), B = chainOf(b); let i = 0; while (A[i] && A[i] === B[i]) i++; return Math.max(1, i); };
  const ser = d => M.serialize(d, S.project);
  /* Every (field, target) link an item holds. */
  const linksOf = (id, d) => M.fields(id, S.project).filter(f => f.type === 'link' || f.type === 'links')
    .flatMap(f => (f.type === 'link' ? [d[f.k]] : d[f.k] || []).filter(Boolean).map(t => ({ field: f, to: t })));
  const backlinks = id => [...S.work].filter(([oid, d]) => oid !== id && canSee(oid) && linksOf(oid, d).some(l => l.to === id)).map(([oid]) => oid).sort();
  const linking = (prefix, key, id) => idsOf(prefix).filter(o => [].concat(get(o)[key] || []).includes(id));
  const childLevel = key => S.project.levels.find(l => l.parent === key);
  const childrenOf = id => { const c = childLevel(P(id)); return c ? linking(c.key, 'traces', id) : []; };
  const visLevels = () => S.project.levels.filter(l => RANK[acc('requirements/' + l.key)] >= 1);

  function changes() {
    const out = [];
    for (const [id, data] of S.work) {
      const b = S.base.get(id);
      if (!b) out.push({ id, type: 'add', path: `${S.root}/${M.relPath(id, S.project)}`, data });
      else if (ser(data) !== ser(b.data)) out.push({ id, type: 'mod', path: b.path, data, before: b.data, sha: b.sha });
    }
    for (const [id, b] of S.base) if (!S.work.has(id)) out.push({ id, type: 'del', path: b.path, before: b.data, sha: b.sha });
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  function saveDraft() {
    const d = {};
    changes().forEach(c => { d[c.id] = c.type === 'del' ? null : c.data; });
    Object.keys(d).length ? ls.set(draftKey(), d) : ls.del(draftKey());
  }
  function issues() {
    const entries = [...S.work].map(([id, data]) => ({ path: S.base.get(id)?.rel || M.relPath(id, S.project), data }))
      .concat(S.bad.map(b => ({ path: b.rel, data: null, parseError: b.parseError })));
    return M.validate(S.project, entries).filter(i => !M.areaOf(i.id, S.project) || canSee(i.id));
  }
  function nextNum(code) {
    const nums = [...S.work.keys(), ...S.base.keys()].filter(id => M.codeOf(id) === code).map(id => parseInt(id.split('-').pop(), 10) || 0);
    return Math.max(0, ...nums) + 1;
  }
  function fixView() {
    const app = S.view.startsWith('app:') && S.view.slice(4);
    const known = ['hub', 'trace', 'metrics', 'validation', 'team', 'changes', 'history'].includes(S.view) || APPS.some(a => a.key === app);
    if (!known || (app && appAcc(app) === 'none')) S.view = 'hub';
    if (!visLevels().some(l => l.key === S.level)) S.level = visLevels()[0]?.key || '';
  }

  /* ---------------- commit ---------------- */
  async function commit(message, newBranch) {
    const ch = changes();
    if (!ch.length) return;
    const p = me();
    const denied = ch.filter(refused).map(c => c.id);
    if (denied.length) throw new Error(`${p ? p.name : 'You'} cannot change ${denied.join(', ')}. Discard those edits or switch person.`);
    S.committing = true; render();
    try {
      // Re-read the branch tip. If it moved, only proceed when nobody touched the files we are changing.
      const ref = await gh(`${R()}/git/ref/heads/${encRef(S.branch)}`);
      const tip = await gh(`${R()}/git/trees/${ref.object.sha}?recursive=1`);
      if (ref.object.sha !== S.head.sha) {
        const now = new Map(tip.tree.map(e => [e.path, e.sha]));
        const clash = ch.filter(c => now.get(c.path) !== c.sha);
        if (clash.length) throw new Error(`${S.branch} changed on GitHub and touches ${clash.map(c => c.id).join(', ')}. Reload the branch, then re-apply your edits.`);
      }
      const tree = await gh(`${R()}/git/trees`, { method: 'POST', body: {
        base_tree: tip.sha,
        tree: ch.map(c => c.type === 'del'
          ? { path: c.path, mode: '100644', type: 'blob', sha: null }
          : { path: c.path, mode: '100644', type: 'blob', content: ser(c.data) })
      } });
      const body = { message, tree: tree.sha, parents: [ref.object.sha] };
      // A simulated person becomes the git author; the token owner remains the committer.
      if (p) body.author = { name: p.name, email: `${p.login}@${S.team.domain}`, date: new Date().toISOString() };
      const made = await gh(`${R()}/git/commits`, { method: 'POST', body });
      let note;
      if (newBranch) {
        await gh(`${R()}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + newBranch, sha: made.sha } });
        const [title, ...rest] = message.split('\n');
        const prBody = [rest.join('\n').trim(), p ? `Authored in Strata as ${p.name} (${teamOf(p).name}, simulated).` : ''].filter(Boolean).join('\n\n');
        const pr = await gh(`${R()}/pulls`, { method: 'POST', body: { title, body: prBody, head: newBranch, base: S.branch } })
          .catch(e => { toast('Branch pushed, but the pull request could not be opened: ' + e.message, true); return null; });
        ls.del(draftKey());
        S.branches.push(newBranch);
        note = pr && /^https:\/\/github\.com\//.test(pr.html_url)
          ? `Opened <a href="${esc(pr.html_url)}" target="_blank" rel="noopener">pull request #${esc(pr.number)}</a> into ${esc(S.branch)}.`
          : `Committed to new branch ${esc(newBranch)}.`;
        S.view = 'hub';
        await loadBranch(newBranch);
      } else {
        await gh(`${R()}/git/refs/heads/${encRef(S.branch)}`, { method: 'PATCH', body: { sha: made.sha, force: false } });
        ls.del(draftKey());
        note = `Committed <span class="mono">${esc(made.sha.slice(0, 7))}</span> to ${esc(S.branch)}.`;
        S.view = 'history';
        await loadBranch(S.branch);
      }
      toastHtml(note);
    } finally { S.committing = false; render(); }
  }

  /* ---------------- rendering helpers ---------------- */
  function toast(msg, err) { toastHtml(esc(msg), err); }
  function toastHtml(html, err) {
    const d = document.createElement('div');
    if (err) d.className = 'err';
    d.innerHTML = html;
    $('#toast').append(d);
    setTimeout(() => d.remove(), err ? 9000 : 6000);
  }
  const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
  const TONES = { grey: ['draft', 'planned', 'proposed', 'open'], amber: ['review', 'mitigating', 'agreed', 'blocked', 'developing', 'compliance risk', 'TBD'], green: ['approved', 'passed', 'accepted', 'baselined', 'closed', 'stable', 'compliant', 'Yes'], red: ['obsolete', 'failed', 'superseded', 'unstable', 'non-compliant', 'impacting', 'No'] };
  const tone = s => Object.keys(TONES).find(t => TONES[t].includes(s)) || 'grey';
  const dot = s => `<span class="dot t-${tone(s)}"></span>`;
  /* Red / amber / green by position in the project's list, so renamed criteria keep their colour. */
  const ragTone = (k, v) => ['green', 'amber', 'red'][S.project[k === 'stability' ? 'stabilities' : 'compliances'].indexOf(v)] || 'grey';
  const rag = (k, v) => v ? `<span class="rag t-${ragTone(k, v)}">${esc(v)}</span>` : '';
  function ragBar(ids, k) {
    if (!ids.length) return '<span class="muted">–</span>';
    const n = { green: 0, amber: 0, red: 0, grey: 0 };
    ids.forEach(id => { n[k === 'status' ? tone(get(id)[k]) : ragTone(k, get(id)[k])]++; });
    return `<div class="ragbar" title="green ${n.green}, amber ${n.amber}, red ${n.red}, not set ${n.grey}">${['green', 'amber', 'red', 'grey'].map(t => n[t] ? `<i class="t-${t}" style="flex:${n[t]}">${n[t]}</i>` : '').join('')}</div>`;
  }
  const st = s => `<span>${dot(s)}${esc(s)}</span>`;
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
  const refbtn = id => !S.work.has(id) ? `<span class="refbtn bad">${esc(id)}</span>`
    : canSee(id) ? `<button type="button" class="refbtn" data-act="open" data-id="${esc(id)}" title="${esc(get(id).title)}">${esc(id)}</button>`
    : `<span class="refbtn locked" title="You do not have access to this item">restricted</span>`;
  const refText = list => list.map(id => S.work.has(id) && !canSee(id) ? 'restricted' : esc(id)).join(', ');
  const statusBar = (list, key) => {
    const counts = {};
    list.forEach(id => { const v = get(id)[key]; counts[v] = (counts[v] || 0) + 1; });
    return `<div class="bar">${Object.entries(counts).map(([v, n]) => `<i class="t-${tone(v)}" style="width:${100 * n / list.length}%" title="${esc(v)}: ${n}"></i>`).join('')}</div>`;
  };
  const legend = values => `<div class="legend">${values.map(v => st(v)).join('')}</div>`;
  const match = (id, d) => { const q = S.q.trim().toLowerCase(); return !q || [id, ...Object.values(d)].join(' ').toLowerCase().includes(q); };
  const search = what => `<input id="q" type="search" placeholder="Search ${esc(what)}" value="${esc(S.q)}" aria-label="Search">`;
  const newBtn = (prefix, label) => canEditPrefix(prefix) ? `<button class="btn" data-act="new" data-prefix="${esc(prefix)}">+ New ${esc(label)}</button>` : '';

  /* ---------------- shell ---------------- */
  function render() {
    const el = $('#shell');
    if (!S.repoInfo) { el.innerHTML = S.loading ? `<div class="loading">${esc(S.loading)}</div>` : connectView(); return; }
    const iss = S.loading ? [] : issues();
    const ch = S.loading ? [] : changes();
    const p = me();
    const nav = (view, label, count, hot, locked) => `<button data-act="view" data-view="${esc(view)}" class="${S.view === view ? 'on' : ''}" ${locked ? 'disabled' : ''}>${esc(label)}${locked ? '<span class="count">locked</span>' : count != null ? `<span class="count ${hot ? 'hot' : ''}">${count}</span>` : ''}</button>`;
    const q = document.activeElement?.id === 'q' ? [document.activeElement.selectionStart] : null;
    el.innerHTML = `
      <aside class="sidebar">
        <div class="brand"><span class="brand-icon">S</span><span>STRATA<span class="brand-sub">GIT-BACKED SE HUB</span></span></div>
        <div class="side-title">${esc(S.project.name)}</div>
        <nav class="nav">
          ${nav('hub', 'Hub')}
          <div class="nav-sep"></div>
          ${APPS.map(a => nav('app:' + a.key, a.name, null, false, appAcc(a.key) === 'none')).join('')}
          <div class="nav-sep"></div>
          ${nav('trace', 'Trace')}
          ${nav('metrics', 'Metrics')}
          ${nav('validation', 'Validation', iss.length || null, iss.some(i => i.severity === 'error'))}
          ${nav('team', 'Team and access')}
          <div class="nav-sep"></div>
          ${nav('changes', 'Changes', ch.length || null, true)}
          ${nav('history', 'History')}
        </nav>
        <div class="side-bottom">
          ${S.team.users.length ? `<div><label for="persona">Acting as (simulated)</label>${personaSelect('persona')}</div>` : ''}
          <div><label for="branch">Branch</label>
            <select id="branch" data-change="branch">${S.branches.map(b => `<option ${b === S.branch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
          <div class="repo-line"><a href="${webUrl()}" target="_blank" rel="noopener">${esc(S.owner)}/${esc(S.repo)}</a>${S.head ? ` @ ${esc(S.head.sha.slice(0, 7))}` : ''}
            <br><button data-act="reload" class="linkish">Reload from GitHub</button></div>
          <div class="who">${S.user
            ? `${/^https:\/\/avatars\.githubusercontent\.com\//.test(S.user.avatar_url) ? `<img src="${esc(S.user.avatar_url)}" alt="">` : ''}<span>${esc(S.user.login)}</span><button data-act="signout">Sign out</button>`
            : `<span>No token: read-only</span><button data-act="signout">Sign in</button>`}</div>
        </div>
      </aside>
      <main class="main">${S.loading ? `<div class="loading">${esc(S.loading)}</div>` : mainView(iss, ch, p)}</main>`;
    if (q) { const i = $('#q'); if (i) { i.focus(); i.setSelectionRange(q[0], q[0]); } }
    if (S.view === 'trace' && !S.loading) requestAnimationFrame(drawTrace);
  }
  const personaSelect = id => `<select id="${id}" data-change="persona">
      <option value="">Yourself${S.user ? ` (${esc(S.user.login)})` : ''}</option>
      ${S.team.teams.map(t => `<optgroup label="${esc(t.name)}">${S.team.users.filter(u => u.team === t.key).map(u => `<option value="${esc(u.login)}" ${u.login === S.persona ? 'selected' : ''}>${esc(u.name)} · ${esc(u.role)}</option>`).join('')}</optgroup>`).join('')}
    </select>`;

  function connectView() {
    const cfg = ls.get('se.cfg', {});
    return `<div class="connect">
      <div class="connect-side">
        <div class="brand"><span class="brand-icon">S</span><span>STRATA<span class="brand-sub">GIT-BACKED SE HUB</span></span></div>
        <h1>Systems engineering that lives in a git repository.</h1>
        <p>Every requirement, interface, risk and test is a file. Every change is a commit. Review, sign-off and access control come from the git host you already run.</p>
        <div class="stack"><div>this page · static, no server</div><div>api.github.com · your identity, your permissions</div><div>repository · model/**/*.json</div></div>
      </div>
      <form class="connect-form" data-submit="connect">
        <h2>Connect a repository</h2>
        ${S.error ? `<div class="banner err">${esc(S.error)}</div>` : ''}
        <label class="field"><span>Repository</span><input name="repo" placeholder="owner/name" required value="${esc(cfg.repo || guessRepo())}" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>GitHub token</span><input name="token" type="password" placeholder="github_pat_…  (leave empty to browse a public repo read-only)" autocomplete="off" value="${esc(S.token)}"></label>
        <div class="help">Use a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained personal access token</a> limited to this repository, with <code>Contents: read and write</code> and <code>Pull requests: read and write</code>. The token is sent only to api.github.com and never leaves this browser otherwise.</div>
        <label class="checkline"><input type="checkbox" name="remember"> Remember the token on this device (otherwise it is forgotten when the tab closes)</label>
        <label class="field"><span>Model folder</span><input name="root" value="${esc(cfg.root || new URLSearchParams(location.search).get('root') || 'model')}" spellcheck="false"></label>
        <div><button class="btn" type="submit">Connect</button></div>
      </form>
    </div>`;
  }

  /* What the current page is as a document: used for baselines, file names and print stamps. */
  function docInfo() {
    const app = S.view.slice(4), a = APPS.find(x => x.key === app) || { name: S.view };
    const what = app === 'REQ' ? `${level(S.level)?.name || ''} requirements` : app === 'INT' && S.intLevel ? `Interfaces, level ${S.intLevel}` : a.name;
    const scope = S.spec && S.work.has(S.spec) ? `${sysOf(S.spec)} ${get(S.spec).title}${String(S.specDepth) === '0' ? '' : ' and below'}` : 'all systems';
    return { app, system: S.spec ? sysOf(S.spec) : 'ALL', title: `${S.project.name}: ${what}, ${scope}`,
      key: [app, app === 'REQ' ? S.level : app === 'INT' ? 'L' + (S.intLevel || 'all') : '', S.spec ? sysOf(S.spec) + '/' + S.specDepth : 'ALL'].filter(Boolean).join(':') };
  }
  function stampHtml() {
    const e = S.frozen || S.stamp, repo = `${esc(S.owner)}/${esc(S.repo)}`;
    return e && !e.draft
      ? `<b>${esc(e.title)}</b> · <b>Baseline v${esc(e.version)}</b> (${esc(e.type)}) · exported by ${esc(e.by)}, ${esc(when(e.date))} · ${repo} @ ${esc(e.commit.slice(0, 7))}${e.description ? ' · ' + esc(e.description) : ''}`
      : `<b>${esc(docInfo().title)}</b> · <b>UNCONTROLLED DRAFT</b>, not a baseline · ${repo} @ ${esc(S.head.sha.slice(0, 7))} · ${esc(when(new Date().toISOString()))}`;
  }
  function mainView(iss, ch, p) {
    if (S.frozen) { const e = S.frozen; return `<div class="banner frozen"><div><b>Baseline v${esc(e.version)}</b> (${esc(e.type)}) of ${esc(e.title)}<br>As exported by ${esc(e.by)} on ${esc(when(e.date))}, at commit <span class="mono">${esc(e.commit.slice(0, 7))}</span>${e.description ? ': ' + esc(e.description) : ''}. Read-only.</div>
      <span style="flex:1"></span><button class="btn" data-act="print">Print / PDF this baseline</button><button class="btn ghost" data-act="reload">Back to current</button></div>` + mainView2(iss, ch, p); }
    return mainView2(iss, ch, p);
  }
  function mainView2(iss, ch, p) {
    const top = (title, sub, right = '') => `<div class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="spacer"></div>${right}
      ${ch.length && S.view !== 'changes' ? `<button class="btn amber" data-act="view" data-view="changes">Review ${plural(ch.length, 'change')}</button>` : ''}</div>`;
    const ro = canPush() ? '' : `<div class="banner">${S.token ? 'Your GitHub account cannot push to this repository, so everything is read-only.' : 'Browsing without a token: everything is read-only.'}</div>`;
    const app = S.view.startsWith('app:') ? S.view.slice(4) : '';
    const accNote = app && p ? `<div class="banner sim">${avatar(p, 20)} <b>${esc(p.name)}</b> · ${esc(teamOf(p).name)}: ${esc(ACC_LABEL[appAcc(app)].toLowerCase())} here.</div>` : '';
    if (S.view === 'hub') return top(S.project.name, esc(S.project.description || '')) + ro + hubView(iss, ch, p);
    if (S.view === 'trace') return top('Trace', 'Hover an item to follow its chain from stakeholder need to verification.') + traceView(iss);
    if (S.view === 'metrics') return top('Metrics', 'Stability and compliance at a glance, by requirement level and by system.') + metricsView();
    if (S.view === 'validation') return top('Validation', 'Schema and link checks, run in the browser on every edit and in CI on every push.') + validationView(iss);
    if (S.view === 'team') return top('Team and access', 'Who is on the project and what each team may see or change.') + teamView(p);
    if (S.view === 'changes') return top('Changes', `Saved changes waiting to be committed to <span class="mono">${esc(S.branch)}</span>. They are kept in this browser until then.`) + ro + changesView(ch, iss, p);
    if (S.view === 'history') return top('History', `Commits touching <span class="mono">${esc(S.root)}/</span> on <span class="mono">${esc(S.branch)}</span>.`) + `<div class="card">${commitList(S.commits) || '<div class="empty">No commits found.</div>'}</div>`;
    const a = APPS.find(x => x.key === app);
    const right = { REQ: () => newBtn(S.level, 'requirement') + (S.level === leaf() ? newBtn('ASS', 'assumption') : ''), PBS: () => newBtn('PBS', 'system'), INT: () => newBtn('INT', 'interface'), VER: () => newBtn('VER', 'case'), RSK: () => newBtn('RSK', 'risk'), DEC: () => newBtn('DEC', 'decision') }[app]();
    const printHead = `<div class="print-head">${stampHtml()}</div>`;
    return printHead + top(a.name, esc(a.blurb), right) + ro + accNote + appViews[app](iss, ch);
  }

  /* ---------------- hub ---------------- */
  function appStat(k) {
    if (k === 'REQ') {
      const all = visLevels().flatMap(l => idsOf(l.key));
      const lower = all.filter(id => level(P(id)).parent && get(id).status !== 'obsolete' && get(id).object === 'requirement');
      const na = all.filter(id => M.codeOf(id) === 'ASS').length;
      return [`${plural(all.length - na, 'requirement')}, ${plural(na, 'assumption')}`, `${pct(lower.filter(id => (get(id).traces || []).length).length, lower.length)} traced upward`];
    }
    const list = idsOf(k), n = v => list.filter(id => v(get(id))).length;
    if (k === 'PBS') return [plural(list.length, 'system'), `${n(d => d.status === 'approved')} approved, ${n(d => d.status !== 'approved')} proposed`];
    if (k === 'INT') return [plural(list.length, 'interface'), `${n(d => d.agreedFrom === 'Yes' && d.agreedTo === 'Yes')} agreed by both systems, ${n(d => d.maturity === S.project.interfaceMaturity[0])} only identified`];
    if (k === 'VER') return [plural(list.length, 'case'), `${n(d => d.result === 'passed')} passed, ${n(d => d.result === 'failed')} failed`];
    if (k === 'RSK') return [`${n(d => d.status !== 'closed')} active risks`, `${n(d => d.status === 'impacting')} impacting (issues), ${n(d => d.status !== 'closed' && d.likelihood * d.impact >= 12)} high`];
    return [plural(list.length, 'decision'), `${n(d => d.status === 'proposed')} awaiting a decision`];
  }
  function hubView(iss, ch, p) {
    const errs = iss.filter(i => i.severity === 'error').length;
    return `<div class="card persona">
        ${p ? avatar(p, 44) : `<span class="av" style="background:var(--teal-deep);width:44px;height:44px;font-size:18px">${esc((S.user?.login || '?')[0].toUpperCase())}</span>`}
        <div class="persona-who"><div class="eyebrow">Signed in as</div>
          <b>${p ? esc(p.name) : esc(S.user?.login || 'Anonymous reader')}</b>
          <div class="muted">${p ? `${esc(p.role)} · ${esc(teamOf(p).name)}` : (canPush() ? 'Your own GitHub permissions: full access' : 'Read-only')}</div></div>
        ${S.team.users.length ? `<div class="persona-pick"><label class="eyebrow" for="persona2">Try the hub as someone else</label>${personaSelect('persona2')}
          <div class="help">Simulated. GitHub still sees ${esc(S.user?.login || 'an anonymous reader')}; commits you make are authored as the chosen person.</div></div>` : ''}
      </div>
      <div class="grid tiles">${APPS.map(a => {
        const lvl = appAcc(a.key), locked = lvl === 'none', [s1, s2] = locked ? ['', ''] : appStat(a.key);
        return `<button class="card tile ${locked ? 'locked' : ''}" data-act="view" data-view="app:${a.key}" ${locked ? 'disabled' : ''}>
          <span class="tile-head"><b>${esc(a.name)}</b>${chip('acc-' + lvl, ACC_LABEL[lvl])}</span>
          <span class="tile-blurb">${esc(locked ? 'Your team has no access to this area.' : a.blurb)}</span>
          <span class="tile-stat">${locked ? '' : `<b>${esc(s1)}</b>${s2 ? `<span>${esc(s2)}</span>` : ''}`}</span></button>`;
      }).join('')}</div>
      <div class="grid tiles small">
        <button class="card tile" data-act="view" data-view="trace"><span class="tile-head"><b>Trace</b></span><span class="tile-blurb">Need to requirement to verification, end to end.</span></button>
        <button class="card tile" data-act="view" data-view="metrics"><span class="tile-head"><b>Metrics</b></span><span class="tile-blurb">RAG status for stability and compliance, by level and system.</span></button>
        <button class="card tile" data-act="view" data-view="validation"><span class="tile-head"><b>Validation</b>${iss.length ? chip(errs ? 'error' : 'warn', errs ? plural(errs, 'error') : plural(iss.length, 'warning')) : chip('add', 'clean')}</span><span class="tile-blurb">Model checks that also run in CI.</span></button>
        <button class="card tile" data-act="view" data-view="changes"><span class="tile-head"><b>Changes</b>${ch.length ? chip('mod', ch.length + ' saved') : ''}</span><span class="tile-blurb">Review saved changes, then commit or open a pull request.</span></button>
      </div>
      <div class="grid two">
        <div class="card"><h3>Project teams</h3>${S.team.teams.map(t => `<div class="team-row"><span class="dot" style="background:${teamColor(t.key)}"></span><b>${esc(t.name)}</b>
          <span class="team-people">${S.team.users.filter(u => u.team === t.key).map(u => `<button class="av-btn" data-act="persona" data-login="${esc(u.login)}" title="Act as ${esc(u.name)}, ${esc(u.role)}">${avatar(u)}</button>`).join('')}</span></div>`).join('') || '<div class="muted">No team.json in the model.</div>'}
          <div style="margin-top:12px"><button class="linkish dark" data-act="view" data-view="team">See who can access what</button></div></div>
        <div class="card"><h3>Recent activity</h3>${commitList(S.commits.slice(0, 7)) || '<div class="muted">No commits found.</div>'}</div>
      </div>`;
  }

  function commitList(list) {
    return list.map(c => {
      const name = c.commit.author?.name || c.author?.login || '';
      const u = S.team.users.find(x => x.name === name);
      return `<div class="commit">
        <a class="sha" href="${esc(/^https:\/\/github\.com\//.test(c.html_url) ? c.html_url : '#')}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a>
        <div class="msg">${esc(c.commit.message.split('\n')[0])}</div>
        <div class="meta">${u ? avatar(u, 16) + ' ' : ''}${esc(name)} · ${esc(when(c.commit.author?.date))}</div></div>`;
    }).join('');
  }

  /* ---------------- product breakdown helpers ---------------- */
  const cmpKids = id => idsOf('PBS').filter(c => get(c).parent === id);
  /* Depth-first list of visible components: [{ id, depth }] */
  function pbsOrder() {
    const all = idsOf('PBS'), seen = new Set(), out = [];
    const walk = (id, depth) => { if (seen.has(id)) return; seen.add(id); out.push({ id, depth }); cmpKids(id).forEach(c => walk(c, depth + 1)); };
    all.filter(id => !all.includes(get(id).parent)).forEach(r => walk(r, 0));
    all.forEach(id => walk(id, 0));   // anything left is in a parent cycle
    return out;
  }
  function subtree(id, depth) {
    const seen = new Set(), out = [];
    const walk = (x, d) => { if (seen.has(x) || (depth !== 'all' && d > +depth)) return; seen.add(x); out.push({ id: x, depth: d }); cmpKids(x).forEach(c => walk(c, d + 1)); };
    walk(id, 0);
    return out;
  }
  const rolled = (id, prefix = leaf()) => new Set(subtree(id, 'all').flatMap(e => homed(e.id, prefix)));

  /* ---------------- grid: spreadsheet-style table with column chooser, sort and export ---------------- */
  const checkCol = () => ({ k: '_checks', label: 'Checking', w: 200, check: true, get: (id, d) => checkText(d) });
  function reqCols(lvl) {
    const off = ['object', 'rationale', 'stabilityRationale', 'complianceRationale', 'complianceEvidence'];
    const wide = { title: 130, text: 240, rationale: 200, source: 120, stabilityRationale: 180, complianceRationale: 180, complianceEvidence: 180 };
    const cols = [{ k: 'id', label: 'ID' }];
    M.fields(lvl + '-000', S.project).forEach(f => cols.push({ k: f.k, label: f.k === 'traces' ? 'Traces to' : f.label, w: wide[f.k], off: off.includes(f.k),
      pill: f.k === 'status', rag: f.rag, get: (id, d) => f.k === 'system' ? sysLabel(id) : f.type === 'links' ? refText(d[f.k] || []) : show(d[f.k]) }));
    if (lvl === leaf() && RANK[acc('verification')] >= 1) cols.push({ k: '_cases', label: 'Verified by', off: true, get: id => linking('VER', 'verifies', id).join(', ') });
    cols.push(checkCol());
    return cols;
  }
  /* Columns straight from a type's schema, for the simpler registers. */
  function fieldCols(code, off = [], wide = {}) {
    const cols = [{ k: 'id', label: 'ID' }];
    M.fields(code + '-000', S.project).forEach(f => cols.push({ k: f.k, label: f.short || f.label.replace(/ \(.*\)$/, ''), w: wide[f.k] || (f.type === 'area' ? 200 : f.type === 'text' ? 150 : 0), off: off.includes(f.k),
      dot: ['status', 'result'].includes(f.k), pill: ['agreedFrom', 'agreedTo'].includes(f.k), get: (id, d) => f.type === 'links' ? refText(d[f.k] || []) : f.type === 'link' ? (S.work.has(d[f.k]) && canSee(d[f.k]) ? `${sysOf(d[f.k])} · ${get(d[f.k]).title}` : refText([d[f.k]].filter(Boolean))) : show(d[f.k]) }));
    return cols;
  }
  const rds = id => S.project.rds.aspect + sysOf(id);
  const depthOf = id => sysOf(id).split('.').length - 1;
  const cmpCols = () => [
    { k: 'id', label: 'ID' },
    { k: '_rds', label: `${S.project.rds.scheme} code`, get: id => rds(id) },
    { k: 'title', label: 'System name', w: 200, tree: true, get: (id, d) => d.title },
    { k: '_level', label: 'Level', get: id => 'L' + depthOf(id) },
    { k: 'kind', label: 'Kind', get: (id, d) => d.kind },
    { k: 'status', label: 'Control status', dot: true, get: (id, d) => d.status || '' },
    { k: 'safetyClass', label: 'Safety class', get: (id, d) => d.safetyClass || '' },
    { k: 'owner', label: 'System owner', get: (id, d) => d.owner || '' },
    { k: 'company', label: 'Owner company', get: (id, d) => d.company || '' },
    { k: 'parent', label: 'Part of', get: (id, d) => d.parent || '' },
    { k: '_own', label: 'Requirements', get: id => homed(id, leaf()).length },
    { k: '_all', label: 'Incl. levels below', get: id => S.work.has(id) ? rolled(id).size : '' },
    { k: '_if', label: 'Interfaces', get: id => idsOf('INT').filter(i => get(i).from === id || get(i).to === id).length },
    ...(RANK[acc('risks')] >= 1 ? [{ k: '_rsk', label: 'Active risks', get: id => homed(id, 'RSK').filter(r => get(r).status !== 'closed').length }] : []),
    checkCol(),
    { k: 'description', label: 'Description', w: 280, off: true, get: (id, d) => d.description || '' }
  ];
  const rskCols = () => {
    const lab = (arr, v) => v ? `${v} · ${arr[v - 1] || ''}` : '';
    return [
      { k: 'id', label: 'ID' }, { k: '_sys', label: 'System', get: id => sysLabel(id) },
      { k: 'title', label: 'Title', w: 180, get: (id, d) => d.title },
      { k: 'cause', label: 'If', w: 230, get: (id, d) => d.cause || '' }, { k: 'consequence', label: 'Then', w: 230, get: (id, d) => d.consequence || '' },
      { k: 'likelihood', label: 'Likelihood', get: (id, d) => lab(S.project.likelihoodLabels, d.likelihood) },
      { k: 'impact', label: 'Impact', get: (id, d) => lab(S.project.impactLabels, d.impact) },
      { k: '_score', label: 'Score', get: (id, d) => d.likelihood * d.impact },
      { k: 'status', label: 'Status', dot: true, get: (id, d) => d.status },
      { k: 'owner', label: 'Owner', get: (id, d) => d.owner || '' },
      { k: 'mitigation', label: 'Mitigation', w: 240, off: true, get: (id, d) => d.mitigation || '' },
      { k: 'requirements', label: 'Related requirements', off: true, get: (id, d) => refText(d.requirements || []) }
    ];
  };
  /* System selector shared by the per-system pages (requirements, risks). */
  function sysBar(prefix, allLabel) {
    const order = pbsOrder();
    if (!idsOf('PBS').includes(S.spec)) S.spec = '';
    if (!order.length) return '';
    const path = chainOf(S.spec).filter(c => canSee(c));
    return `<div class="card specbar">
      <label class="field"><span>System</span><select data-change="spec">
        <option value="">${esc(allLabel)}</option>
        ${order.map(e => `<option value="${esc(e.id)}" ${e.id === S.spec ? 'selected' : ''}>${'\u00a0\u00a0\u00a0'.repeat(e.depth)}${esc(sysOf(e.id))} · ${esc(get(e.id).title)} (${rolled(e.id, prefix).size})</option>`).join('')}</select></label>
      ${S.spec ? `<label class="field"><span>Levels shown</span><select data-change="specDepth">
        ${[['0', 'This system only (n)'], ['1', 'Down to n+1'], ['2', 'Down to n+2'], ['all', 'All levels below']].map(([v, t]) => `<option value="${v}" ${String(S.specDepth) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="crumbs"><span class="section-lbl">Path</span> ${path.map((c, i) => i === path.length - 1 ? `<b>${esc(get(c).title)}</b>` : `<button class="linkish dark" data-act="spec" data-stay="1" data-id="${esc(c)}">${esc(get(c).title)}</button> ›`).join(' ')}
        ${cmpKids(S.spec).length ? `<span class="section-lbl" style="margin-left:14px">n+1</span> ${cmpKids(S.spec).map(c => `<button class="refbtn" data-act="spec" data-stay="1" data-id="${esc(c)}">${esc(get(c).title)}</button>`).join('')}` : ''}</div>`
      : `<div class="help" style="align-self:center">Pick a system to see only what belongs to it, grouped with the levels below it.</div>`}
    </div>`;
  }
  /* Rows for a per-system page: grouped by system when one is selected, otherwise a flat list. Call sysBar first. */
  function scopedRows(prefix, pass, ch, sorter) {
    const srt = l => sorter ? l.sort(sorter) : l.sort();
    if (S.spec) {
      const rows = [];
      subtree(S.spec, S.specDepth).forEach(e => {
        const list = srt(homed(e.id, prefix).filter(pass));
        rows.push({ group: true, el: e.id, depth: e.depth, n: list.length });
        list.forEach(r => rows.push({ id: r, el: e.id }));
      });
      return rows;
    }
    const deleted = ch.filter(c => c.type === 'del' && P(c.id) === prefix && canSee(c.id)).map(c => c.id);
    return srt([...idsOf(prefix), ...deleted].filter(pass)).map(id => ({ id }));
  }
  const colHidden = (key, c) => { const h = S.grid[key]?.hidden; return c.k !== 'id' && (h ? h.includes(c.k) : !!c.off); };
  const cellOf = (c, id, d) => c.k === 'id' ? id : c.get(id, d);
  function grid(key, cols, rows, iss, ch, name) {
    const g = S.grid[key] || {}, vis = cols.filter(c => !colHidden(key, c));
    const data = id => get(id) || S.base.get(id).data;
    const grouped = rows.some(r => r.group);
    if (g.sort && !grouped) {
      const c = cols.find(x => x.k === g.sort.k);
      if (c) rows = rows.slice().sort((a, b) => g.sort.dir * String(cellOf(c, a.id, data(a.id))).localeCompare(String(cellOf(c, b.id, data(b.id))), undefined, { numeric: true }));
    }
    S.lastGrid = { cols, rows, name, key };
    const items = rows.filter(r => !r.group);
    const body = rows.map(r => {
      if (r.group) { const e = get(r.el); return `<tr class="grp"><td colspan="${vis.length}"><span style="padding-left:${r.depth * 16}px"></span><span class="lvl">${r.depth ? 'n+' + r.depth : 'n'}</span>
        <button class="linkish dark mono" data-act="open" data-id="${esc(r.el)}">${esc(sysOf(r.el))}</button> <b>${esc(e.title)}</b>${e.company ? ` · ${esc(e.company)}` : ''} <span class="muted">· ${plural(r.n, 'item')}</span></td></tr>`; }
      const d = data(r.id), gone = !S.work.has(r.id), c = ch.find(x => x.id === r.id), mine = iss.filter(i => i.id === r.id);
      return `<tr class="${c ? 'changed' : ''} ${gone ? 'gone' : ''} ${M.codeOf(r.id) === 'ASS' ? 'ass' : ''}" data-act="open" data-id="${esc(r.id)}" tabindex="0">${vis.map(col => {
        if (col.k === 'id') return `<th scope="row"><span class="ref">${esc(r.id)}</span>${M.codeOf(r.id) === 'ASS' ? chip('asm', 'assumption') : ''}${c ? chip(c.type, { add: 'new', mod: 'edited', del: 'deleted' }[c.type]) : ''}${mine.length ? chip(mine[0].severity, mine.length + (mine[0].severity === 'error' ? ' err' : ' warn')) : ''}</th>`;
        const v = cellOf(col, r.id, d);
        if (col.check) { const o = openChecks(d).length; return `<td>${o ? chip('warn', o + ' open') + ' ' : ''}${esc(o ? v.replace(/^\d+ open · /, '') : v)}</td>`; }
        return `<td class="${col.w ? '' : 'nw'}" ${col.tree && !g.sort ? `style="padding-left:${9 + (r.depth || 0) * 16}px"` : ''}>${col.rag ? rag(col.k, v) : col.pill ? (v ? `<span class="rag t-${tone(v)}">${esc(v)}</span>` : '') : (col.dot && v ? dot(v) : '') + (col.tree ? `<b>${esc(v)}</b>` : esc(v))}</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `<div class="grid-bar"><span class="n">${plural(items.length, 'row')}${grouped ? ` in ${plural(rows.length - items.length, 'system')}` : ''} · ${vis.length} of ${cols.length} columns</span>
        <details class="cols" ${S.colsOpen ? 'open' : ''}><summary class="btn ghost">Columns</summary><div class="cols-menu">
          <div class="cols-top"><button type="button" class="btn ghost" data-act="colsAll" data-grid="${esc(key)}">Show all</button><button type="button" class="btn ghost" data-act="colsReset" data-grid="${esc(key)}">Default</button></div>
          ${cols.filter(c => c.k !== 'id').map(c => `<label><input type="checkbox" data-change="col" data-grid="${esc(key)}" data-k="${esc(c.k)}" ${colHidden(key, c) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('')}</div></details>
        ${S.frozen ? '' : `<button class="btn ghost" data-act="csv">Export CSV</button><button class="btn ghost" data-act="export" data-format="pdf">Print / PDF</button>`}
        <button class="btn ghost" data-act="baselines">Baselines${S.exports.filter(e => e.app === S.view.slice(4)).length ? ` (${S.exports.filter(e => e.app === S.view.slice(4)).length})` : ''}</button></div>
      <div class="grid-wrap"><table class="sheet"><thead><tr>${vis.map(c => `<th ${c.w ? `style="min-width:${c.w}px"` : ''}>${grouped ? esc(c.label)
        : `<button data-act="sort" data-grid="${esc(key)}" data-k="${esc(c.k)}">${esc(c.label)}${g.sort?.k === c.k ? (g.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`}</th>`).join('')}</tr></thead>
        <tbody>${body || `<tr class="none"><td colspan="${vis.length}">${S.q || Object.values(S.f).some(Boolean) ? 'Nothing matches the search and filters.' : 'Nothing here yet.'}</td></tr>`}</tbody></table></div>`;
  }
  /* Every column, not only the visible ones; the rows are whatever the table currently shows. */
  function exportCsv() {
    if (!S.lastGrid) return;
    const { cols, rows, name } = S.lastGrid;
    // A leading quote stops spreadsheet apps from running a cell as a formula.
    const cell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const repo = `${S.owner}/${S.repo}`;
    const top = [['UNCONTROLLED – INFORMATION ONLY'], [docInfo().title], [`${repo} @ ${S.head.sha.slice(0, 7)} · ${new Date().toISOString()}`]];
    const lines = [...top, [], cols.map(c => c.label), ...rows.filter(r => !r.group).map(r => { const d = get(r.id) || S.base.get(r.id).data; return cols.map(c => cellOf(c, r.id, d)); })];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `${S.project.name}-${name}-${S.head.sha.slice(0, 7)}.csv`.replace(/[^\w.-]+/g, '-');
    toast(`Exported ${plural(lines.length - 5, 'row')} to ${a.download}.`);
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  /* Why an export cannot be recorded as a baseline right now ('' if it can). */
  const draftReason = () => S.frozen ? 'you are viewing an old baseline' : !canPush() ? 'you cannot write to the repository' : changes().length ? 'there are saved changes that are not committed yet' : '';
  function nextVersion(key, type) {
    const last = S.exports.filter(e => e.doc === key).pop(), [maj, min] = last ? last.version.split('.').map(Number) : [0, 0];
    return type === 'major' ? `${maj + 1}.0` : `${maj}.${min + 1}`;
  }
  async function doExport(format, type, description) {
    const doc = docInfo();
    let stamp = { draft: true, title: doc.title };
    if (!draftReason()) {
      const g = S.lastGrid || {};
      stamp = { doc: doc.key, title: doc.title, app: doc.app, system: doc.system, version: nextVersion(doc.key, type), type, description, format, by: whoAmI(),
        date: new Date().toISOString(), commit: S.head.sha, branch: S.branch,
        view: { view: S.view, level: S.level, spec: S.spec, specDepth: S.specDepth, f: S.f, q: S.q, intLevel: S.intLevel, gridKey: g.key, hidden: S.grid[g.key]?.hidden, sort: S.grid[g.key]?.sort } };
      await saveRegister([...S.exports, stamp], `Record baseline v${stamp.version} of ${doc.title}`);
      toast(`Recorded baseline v${stamp.version} (${type}).`);
    }
    S.stamp = stamp; S.dialog = null; render(); renderDrawer();
    setTimeout(() => window.print(), 50);
  }
  function dialogHtml() {
    const d = S.dialog, doc = docInfo();
    if (d.kind === 'export') {
      const why = draftReason();
      return `<div class="scrim" data-act="closeDialog"></div><form class="modal" data-submit="export" role="dialog" aria-label="Export">
        <h2>Print / PDF</h2><div class="muted">${esc(doc.title)}</div>
        ${why ? `<div class="banner">This will be an <b>uncontrolled draft</b>, not a recorded baseline, because ${esc(why)}.</div>` : `
        <div class="field"><span>Baseline</span>
          <label class="radio"><input type="radio" name="type" value="minor" checked><span><b>Minor</b> · becomes v${esc(nextVersion(doc.key, 'minor'))}</span></label>
          <label class="radio"><input type="radio" name="type" value="major"><span><b>Major</b> · becomes v${esc(nextVersion(doc.key, 'major'))}</span></label></div>
        <label class="field"><span>Description (optional)</span><textarea name="description" placeholder="Why this export was issued, and to whom"></textarea></label>
        <div class="help">The baseline is recorded in <span class="mono">${esc(S.root)}/exports/register.json</span> against commit <span class="mono">${esc(S.head.sha.slice(0, 7))}</span>, so the same document can be reproduced later.${d.format === 'pdf' ? ' The print dialog opens next: choose “Save as PDF”.' : ''}</div>`}
        <input type="hidden" name="format" value="${esc(d.format)}">
        <div class="modal-foot"><button class="btn" type="submit">${why ? 'Export draft' : 'Record baseline and export'}</button><button type="button" class="btn ghost" data-act="closeDialog">Cancel</button></div></form>`;
    }
    const list = S.exports.map((e, i) => ({ e, i })).filter(x => x.e.app === doc.app).reverse(), systems = [...new Set(list.map(x => x.e.system))].sort();
    return `<div class="scrim" data-act="closeDialog"></div><div class="modal wide" role="dialog" aria-label="Baselines">
      <h2>Baselines: ${esc(APPS.find(a => a.key === doc.app)?.name || '')}</h2><div class="muted">Every recorded export of this data type, by system. Open one to see and re-export exactly what was issued.</div>
      ${systems.map(sys => `<div class="section-lbl" style="margin-top:14px">${sys === 'ALL' ? 'All systems' : esc(sys) + (sysEl(sys) ? ' · ' + esc(get(sysEl(sys)).title) : '')}</div>
        ${list.filter(x => x.e.system === sys).map(({ e, i }) => `<div class="baseline"><span class="rag t-${e.type === 'major' ? 'green' : 'grey'}">v${esc(e.version)}</span>
          <div><b>${esc(e.title)}</b><div class="muted">${esc(e.type)} · ${esc(String(e.format).toUpperCase())} · ${esc(e.by)} · ${esc(when(e.date))} · commit <span class="mono">${esc(e.commit.slice(0, 7))}</span>${e.description ? '<br>' + esc(e.description) : ''}</div></div>
          <button class="btn ghost" data-act="openBaseline" data-i="${i}">Open to re-export</button></div>`).join('')}`).join('') || '<div class="empty">Nothing has been exported as a baseline yet.</div>'}
      <div class="modal-foot"><button type="button" class="btn ghost" data-act="closeDialog">Close</button></div></div>`;
  }

  /* ---------------- apps ---------------- */
  const appViews = {
    REQ(iss, ch) {
      const l = level(S.level);
      if (!l) return '<div class="card empty">No requirement level is visible to you.</div>';
      const FILTERS = [['object', [...S.project.objectTypes, 'assumption'], 'All object types'], ['status', S.project.statuses, 'All statuses'], ['type', S.project.reqTypes, 'All types'], ['compliance', S.project.compliances, 'Any compliance'], ['stability', S.project.stabilities, 'Any stability']];
      const pass = id => { const d = get(id) || S.base.get(id).data; return match(id, d) && FILTERS.every(([k]) => !S.f[k] || d[k] === S.f[k]); };
      const specBar = sysBar(l.key, `All systems: every ${l.key} item`);
      const rows = scopedRows(l.key, pass, ch);
      return `<div class="tabs">${S.project.levels.map(x => RANK[acc('requirements/' + x.key)] >= 1
          ? `<button data-act="level" data-level="${esc(x.key)}" class="${x.key === l.key ? 'on' : ''}"><span class="mono">${esc(x.key)}</span> ${esc(x.name)} <span class="count">${idsOf(x.key).length}</span></button>`
          : `<button disabled><span class="mono">${esc(x.key)}</span> ${esc(x.name)} <span class="count">locked</span></button>`).join('')}</div>
        ${specBar}
        <div class="tools">${search(`${l.key}: any attribute`)}
          ${FILTERS.map(([k, opts, any]) => `<select data-change="filter" data-f="${k}" aria-label="${any}"><option value="">${any}</option>${opts.map(o => `<option ${S.f[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`).join('')}</div>
        ${grid('req:' + l.key, reqCols(l.key), rows, iss, ch, `${l.key}${S.spec ? '-' + sysOf(S.spec) : ''}`)}`;
    },
    PBS(iss, ch) {
      const order = pbsOrder(), max = Math.max(0, ...order.map(e => e.depth));
      S.zoom = Math.min(S.zoom, max);
      const box = (id, depth) => {
        const d = get(id), kids = cmpKids(id), own = homed(id, leaf()).length, all = rolled(id).size;
        return `<div class="pbs k-${esc(d.kind)} c-${esc(d.status)}"><button class="pbs-head" data-act="spec" data-id="${esc(id)}" title="Open the specification for ${esc(d.title)}">
            <span class="ref">${esc(sysOf(id))}${d.status === 'approved' ? '' : ' · ' + esc(d.status || 'not approved')}</span><b>${esc(d.title)}</b>${d.company ? `<span class="pbs-co">${esc(d.company)}</span>` : ''}
            <span class="pbs-n">${own} req${own === 1 ? '' : 's'}${all > own ? ` · ${all} incl. below` : ''}</span></button>
          ${kids.length ? (depth < S.zoom ? `<div class="pbs-kids">${kids.map(k => box(k, depth + 1)).join('')}</div>`
            : `<button class="pbs-more" data-act="zoom" data-z="${depth + 1}">+ ${subtree(id, 'all').length - 1} below</button>`) : ''}</div>`;
      };
      const roots = order.filter(e => e.depth === 0).map(e => e.id);
      const rows = order.filter(e => match(e.id, get(e.id))).map(e => ({ id: e.id, depth: e.depth }));
      return `<div class="card" style="margin-bottom:16px"><div class="zoombar"><h3 style="margin:0">Product breakdown</h3>
            <span class="section-lbl" style="margin-left:auto">Zoom</span>${Array.from({ length: max + 1 }, (_, z) => `<button data-act="zoom" data-z="${z}" class="${z === S.zoom ? 'on' : ''}">${z ? 'n+' + z : 'n'}</button>`).join('')}</div>
          <div class="muted" style="margin:4px 0 12px">Click a system to open its requirements. Zoom out to hide lower levels on a large breakdown.</div>
          <div class="scroll"><div class="pbs-root">${roots.map(r => box(r, 0)).join('') || '<div class="muted">No components yet.</div>'}</div></div></div>
        <div class="tools">${search('the breakdown')}</div>
        ${grid('cmp', cmpCols(), rows, iss, ch, 'PBS')}
        <div class="legend"><span>${dot('approved')}approved: controlled, risks may be raised against it</span><span>${dot('proposed')}proposed</span></div>`;
    },
    INT(iss, ch) {
      const all = idsOf('INT'), lvOf = i => S.work.has(get(i).from) ? String(depthOf(get(i).from)) : '?';
      const levels = [...new Set([...idsOf('PBS').map(depthOf).filter(d => d > 0).map(String), ...all.map(lvOf)])].sort();
      if (!levels.includes(S.intLevel)) S.intLevel = '';
      const ifs = all.filter(i => !S.intLevel || lvOf(i) === S.intLevel);
      const matrix = l => {
        const comps = idsOf('PBS').filter(c => String(depthOf(c)) === l), mine = all.filter(i => lvOf(i) === l);
        return comps.length < 2 ? '' : `<div class="n2-level"><div class="n2-head"><span class="lvl">LVL${esc(l)}</span> ${plural(comps.length, 'system')} at architecture level ${esc(l)} · ${plural(mine.length, 'interface')}</div>
          <div class="scroll"><table class="n2 l${esc(l)}">${comps.map(r => `<tr>${comps.map(c => r === c
            ? `<th><button class="linkish dark" data-act="open" data-id="${esc(r)}"><span class="mono">${esc(rds(r))}</span><br>${esc(get(r).title)}</button></th>`
            : `<td>${mine.filter(i => get(i).from === r && get(i).to === c).map(i => `<button type="button" class="refbtn" data-act="open" data-id="${esc(i)}" title="${esc(get(i).title)}">${esc(i.split('-').slice(-2).join('-'))}</button>`).join('')}</td>`).join('')}</tr>`).join('')}</table></div></div>`;
      };
      const n2 = `<div class="card" style="margin-bottom:16px"><h3>N² view${S.intLevel ? `: architecture level ${esc(S.intLevel)}` : ': one matrix per architecture level'}</h3>
        <div class="muted" style="margin-bottom:6px">Systems on the diagonal. An interface sits in the row of System A and the column of System B; an empty cell is a pair with no interface identified. Interfaces only join systems at the same level, so each level has its own matrix.</div>
        ${(S.intLevel ? [S.intLevel] : levels).map(matrix).join('') || '<div class="muted">No level has two or more systems yet.</div>'}</div>`;
      const rows = ifs.filter(i => match(i, get(i))).map(id => ({ id }));
      return `<div class="tabs"><button data-act="intLevel" data-l="" class="${S.intLevel ? '' : 'on'}">All levels <span class="count">${all.length}</span></button>
          ${levels.map(l => `<button data-act="intLevel" data-l="${esc(l)}" class="${S.intLevel === l ? 'on' : ''}"><span class="mono">LVL${esc(l)}</span> <span class="count">${all.filter(i => lvOf(i) === l).length}</span></button>`).join('')}</div>
        ${n2}<div class="tools">${search('interfaces: any attribute')}</div>
        ${grid('int', [{ k: 'id', label: 'ID' }, { k: '_lvl', label: 'Level', get: id => 'LVL' + lvOf(id) }, ...fieldCols('INT', ['description', 'rationale'], { title: 150 }).slice(1)], rows, iss, ch, `interfaces${S.intLevel ? '-LVL' + S.intLevel : ''}`)}`;
    },
    VER(iss, ch) {
      const list = idsOf('VER'), sys = idsOf(leaf()).filter(id => get(id).status !== 'obsolete');
      const cov = sys.filter(id => linking('VER', 'verifies', id).length), pass = sys.filter(id => { const v = linking('VER', 'verifies', id); return v.length && v.every(x => get(x).result === 'passed'); });
      const un = sys.filter(id => !cov.includes(id));
      return `<div class="grid kpis">
          <div class="card kpi"><div class="num">${list.length}</div><div class="lbl">verification cases</div>${list.length ? statusBar(list, 'result') : ''}</div>
          ${sys.length ? `<div class="card kpi"><div class="num">${pct(cov.length, sys.length)}</div><div class="lbl">${esc(leaf())} requirements with a case (${cov.length}/${sys.length})</div></div>
          <div class="card kpi"><div class="num">${pct(pass.length, sys.length)}</div><div class="lbl">verified: all cases passed (${pass.length}/${sys.length})</div></div>` : ''}
        </div>
        ${un.length ? `<div class="card" style="margin-bottom:16px"><div class="section-lbl" style="margin-bottom:6px">${esc(leaf())} requirements with no case</div>${un.map(refbtn).join('')}</div>` : ''}
        <div class="tools">${search('verification cases: any attribute')}</div>
        ${grid('ver', fieldCols('VER', ['notes'], { title: 160, evidenceDoc: 130 }), idsOf('VER').filter(i => match(i, get(i))).map(id => ({ id })), iss, ch, 'verification')}${legend(['planned', 'blocked', 'passed', 'failed'])}`;
    },
    RSK(iss, ch) {
      const LL = S.project.likelihoodLabels, IL = S.project.impactLabels;
      const data = id => get(id) || S.base.get(id).data, score = id => data(id).likelihood * data(id).impact;
      const bar = sysBar('RSK', 'All systems: every risk');
      const rows = scopedRows('RSK', id => match(id, data(id)), ch, (a, b) => score(b) - score(a) || a.localeCompare(b));
      const scope = S.spec ? subtree(S.spec, S.specDepth).flatMap(e => homed(e.id, 'RSK')) : idsOf('RSK');
      const live = scope.filter(id => get(id).status !== 'closed'), hot = live.filter(id => get(id).status === 'impacting');
      const pin = id => `<button type="button" class="refbtn ${get(id).status === 'impacting' ? 'hot' : ''}" data-act="open" data-id="${esc(id)}" title="${esc(id)} · ${esc(get(id).title)}${get(id).status === 'impacting' ? ' (impacting: now an issue)' : ''}">${esc(id.split('-').slice(-2).join('-'))}</button>`;
      const cell = (l, i) => { const s = l * i; return `<td class="${s >= 12 ? 'hi' : s >= 6 ? 'mid' : 'lo'}">${live.filter(id => get(id).likelihood === l && get(id).impact === i).map(pin).join('')}</td>`; };
      return bar + `<div class="card" style="margin-bottom:16px"><h3>Risk map: ${S.spec ? esc(get(S.spec).title) + (String(S.specDepth) === '0' ? '' : ' and the levels shown below it') : 'all systems'}</h3>
          <div class="muted" style="margin-bottom:10px">${plural(live.length, 'active risk')}${hot.length ? `, of which <b style="color:var(--red)">${hot.length} impacting</b> (now ${hot.length === 1 ? 'an issue' : 'issues'})` : ''}. Closed risks stay in the table below.</div>
          <div class="scroll"><table class="heat"><tr><th></th>${[1, 2, 3, 4, 5].map(i => `<th>${i} · ${esc(IL[i - 1] || '')}</th>`).join('')}</tr>
          ${[5, 4, 3, 2, 1].map(l => `<tr><th>${l} · ${esc(LL[l - 1] || '')}</th>${[1, 2, 3, 4, 5].map(i => cell(l, i)).join('')}</tr>`).join('')}
          <tr><th></th><th colspan="5" class="axis">Impact →  ·  rows: likelihood</th></tr></table></div>
          <div class="legend"><span><span class="refbtn hot" style="margin:0 6px 0 0">ID</span>impacting: the risk has happened and is now an issue</span></div></div>
        <div class="tools">${search('risks: any attribute')}</div>
        ${grid('rsk', rskCols(), rows, iss, ch, `risks${S.spec ? '-' + sysOf(S.spec) : ''}`)}${legend(['open', 'mitigating', 'accepted', 'impacting', 'closed'])}`;
    },
    DEC(iss, ch) {
      return `<div class="tools">${search('decisions: any attribute')}</div>
        ${grid('dec', fieldCols('DEC', ['options'], { title: 170 }), idsOf('DEC').filter(i => match(i, get(i))).map(id => ({ id })), iss, ch, 'decisions')}${legend(['proposed', 'accepted', 'superseded'])}`;
    }
  };

  /* ---------------- trace ---------------- */
  const traceCols = () => [...visLevels().map(l => ({ key: l.key, name: l.name })), ...(RANK[acc('verification')] >= 1 ? [{ key: 'VER', name: 'Verification' }] : [])];
  const upOf = id => (get(id)?.traces || get(id)?.verifies || []).filter(t => S.work.has(t) && canSee(t));
  const downOf = id => [...childrenOf(id), ...(P(id) === leaf() ? linking('VER', 'verifies', id) : [])];
  function traceView(iss) {
    const cols = traceCols();
    if (!cols.length) return '<div class="card empty">Nothing in the trace chain is visible to you.</div>';
    const flagged = new Set(iss.filter(i => ['orphan', 'uncovered', 'trace-dangling', 'trace-level', 'no-case', 'no-target'].includes(i.code)).map(i => i.id));
    return `<div class="scroll"><div class="trace" id="trace" style="grid-template-columns:repeat(${cols.length},minmax(150px,1fr))"><svg aria-hidden="true"></svg>
      ${cols.map(c => `<div class="tcol"><h3>${esc(c.key)} · ${esc(c.name)}</h3>
        ${idsOf(c.key).map(id => { const d = get(id); return `<button class="tnode ${flagged.has(id) ? 'gap' : ''}" data-act="open" data-id="${esc(id)}" data-node="${esc(id)}"><span class="ref">${dot(d.status || d.result)}${esc(id)}</span>${esc(d.title)}</button>`; }).join('') || '<div class="muted">None</div>'}
      </div>`).join('')}</div></div>
      <div class="legend"><span><span class="dot" style="background:none;border:1px dashed #e0a93e"></span>gap: nothing above or nothing below</span>
        <span>${dot('draft')}draft / planned</span><span>${dot('review')}in review / blocked</span><span>${dot('approved')}approved / passed</span><span>${dot('failed')}obsolete / failed</span></div>`;
  }
  function drawTrace() {
    const box = $('#trace'); if (!box) return;
    const svg = $('svg', box), o = box.getBoundingClientRect();
    const node = id => $(`[data-node="${CSS.escape(id)}"]`, box);
    let html = '';
    $$('[data-node]', box).forEach(b => upOf(b.dataset.node).forEach(p => {
      const a = node(p); if (!a) return;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - o.left, y1 = ra.top + ra.height / 2 - o.top, x2 = rb.left - o.left, y2 = rb.top + rb.height / 2 - o.top, mx = (x1 + x2) / 2;
      html += `<path data-from="${esc(p)}" data-to="${esc(b.dataset.node)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }));
    svg.innerHTML = html;
  }
  function chain(id) {
    const set = new Set([id]);
    const up = x => upOf(x).forEach(p => { if (!set.has(p)) { set.add(p); up(p); } });
    const down = x => downOf(x).forEach(c => { if (!set.has(c)) { set.add(c); down(c); } });
    up(id); down(id);
    return set;
  }
  function highlight(id) {
    const box = $('#trace'); if (!box) return;
    const set = id ? chain(id) : null;
    $$('.tnode', box).forEach(n => { n.classList.toggle('hot', !!set && set.has(n.dataset.node)); n.classList.toggle('dim', !!set && !set.has(n.dataset.node)); });
    $$('path', box).forEach(p => { const on = !!set && set.has(p.dataset.from) && set.has(p.dataset.to); p.classList.toggle('hot', on); p.classList.toggle('dim', !!set && !on); });
  }

  /* ---------------- metrics ---------------- */
  function metricsView() {
    const lv = visLevels(), all = lv.flatMap(l => idsOf(l.key));
    const isReq = id => get(id).object === 'requirement' && get(id).status !== 'obsolete';
    const real = all.filter(isReq), ass = all.filter(id => M.codeOf(id) === 'ASS'), lf = real.filter(id => P(id) === leaf());
    const traced = ids => { const lower = ids.filter(id => isReq(id) && level(P(id)).parent); return [lower.filter(id => (get(id).traces || []).length).length, lower.length]; };
    const seeVer = RANK[acc('verification')] >= 1, seeRsk = RANK[acc('risks')] >= 1;
    const verified = ids => ids.filter(id => { const v = linking('VER', 'verifies', id); return v.length && v.every(x => get(x).result === 'passed'); }).length;
    const risks = seeRsk ? idsOf('RSK').filter(id => get(id).status !== 'closed') : [];
    const kpi = (num, lbl) => `<div class="card kpi"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;
    const order = pbsOrder(), pbsAll = [...S.work.keys()].filter(x => M.codeOf(x) === 'PBS');
    const ownerOf = id => { for (let c = sysOf(id); c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') { const e = pbsAll.find(x => sysOf(x) === c); if (e && get(e).owner) return get(e).owner; } return 'Unassigned'; };
    const DIMS = [['system', 'Each system'], ['cumulative', 'System of systems (cumulative)'], ['archlevel', 'Architecture level'], ['reqlevel', 'Requirement level'], ['owner', 'System owner']];
    if (!order.length && ['system', 'cumulative'].includes(S.mdim)) S.mdim = 'reqlevel';
    let groups;   // [{ label (html), ids }]
    if (S.mdim === 'system' || S.mdim === 'cumulative') groups = order.map(e => {
      const codes = S.mdim === 'system' ? [sysOf(e.id)] : subtree(e.id, 'all').map(x => sysOf(x.id));
      return { label: `<span style="padding-left:${e.depth * 16}px"></span><button class="linkish dark" data-act="spec" data-id="${esc(e.id)}"><span class="mono">${esc(rds(e.id))}</span> ${esc(get(e.id).title)}</button>`, ids: all.filter(id => codes.includes(sysOf(id))) };
    });
    else if (S.mdim === 'reqlevel') groups = lv.map(l => ({ label: `<span class="mono">${esc(l.key)}</span> ${esc(l.name)}`, ids: idsOf(l.key) }));
    else if (S.mdim === 'archlevel') groups = [...new Set(all.map(id => sysOf(id).split('.').length - 1))].sort().map(d => ({ label: `Level ${d}`, ids: all.filter(id => sysOf(id).split('.').length - 1 === d) }));
    else groups = [...new Set(all.map(ownerOf))].sort().map(o => { const u = S.team.users.find(x => x.name === o); return { label: `${u ? avatar(u, 20) + ' ' : ''}${esc(o)}`, ids: all.filter(id => ownerOf(id) === o) }; });
    const methods = S.project.verification;
    const row = g => {
      const reqs = g.ids.filter(isReq), [t, tn] = traced(g.ids), obj = {};
      g.ids.forEach(id => { const o = get(id).object || 'not set'; obj[o] = (obj[o] || 0) + 1; });
      const vm = methods.map(m => [m, reqs.filter(id => get(id).verification === m).length]).filter(x => x[1]), none = reqs.filter(id => !get(id).verification).length;
      return `<tr><th>${g.label}</th><td><b>${reqs.length}</b></td><td class="small">${Object.entries(obj).map(([o, n]) => `${n} ${esc(o)}`).join('<br>') || '–'}</td>
        <td>${ragBar(g.ids, 'status')}</td><td>${ragBar(g.ids, 'stability')}</td><td>${ragBar(reqs, 'compliance')}</td><td>${tn ? `${t}/${tn} <span class="muted">(${pct(t, tn)})</span>` : '–'}</td>
        <td class="small">${vm.map(([m, n]) => `${n} ${esc(m)}`).join('<br>')}${none ? `${vm.length ? '<br>' : ''}<span class="amber">${none} not set</span>` : ''}${!vm.length && !none ? '–' : ''}</td></tr>`;
    };
    return `<div class="grid kpis">
        ${kpi(real.length, 'requirements')}${kpi(ass.length, 'assumptions')}
        ${kpi(pct(...traced(all)), 'traced to a parent')}
        ${seeVer ? kpi(pct(verified(lf), lf.length), `${leaf()} verified (all cases passed)`) : ''}
        ${seeRsk ? kpi(risks.length, 'active risks') + kpi(risks.filter(id => get(id).status === 'impacting').length, 'impacting (issues)') : ''}
      </div>
      <div class="tabs">${DIMS.filter(([k]) => order.length || !['system', 'cumulative'].includes(k)).map(([k, t]) => `<button data-act="mdim" data-d="${k}" class="${S.mdim === k ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>
      <div class="card"><div class="muted" style="margin-bottom:10px">${{ system: 'Each row counts only what belongs to that system.', cumulative: 'Each row counts the system and everything below it, so the top row is the whole project.', archlevel: 'Grouped by the breakdown level of the system each item belongs to.', reqlevel: 'Grouped by requirement level.', owner: 'Grouped by the owner of the system each item belongs to; an unowned system rolls up to its parent’s owner.' }[S.mdim]}</div>
        <div class="scroll"><table class="metrics"><tr><th>${esc(DIMS.find(d => d[0] === S.mdim)[1])}</th><th>Requirements</th><th>Object types</th><th>Status</th><th>Stability</th><th>Compliance</th><th>Traced to a parent</th><th>Verification method</th></tr>
        ${groups.map(row).join('')}</table></div>
        <div class="legend"><span><span class="dot t-green"></span>${esc(S.project.stabilities[0])} / ${esc(S.project.compliances[0])}</span><span><span class="dot t-amber"></span>${esc(S.project.stabilities[1])} / ${esc(S.project.compliances[1])}</span><span><span class="dot t-red"></span>${esc(S.project.stabilities[2])} / ${esc(S.project.compliances[2])}</span><span><span class="dot" style="background:#cfc7b4"></span>not set</span><span>Status: ${S.project.statuses.map(x => `${dot(x)}${esc(x)}`).join(' ')}</span></div></div>`;
  }

  /* ---------------- validation / team / changes ---------------- */
  function validationView(iss) {
    if (!iss.length) return `<div class="card empty">No validation tasks in the parts of the model you can see.</div>`;
    const owners = [...new Set(iss.map(i => i.owner))].map(o => ({ o, list: iss.filter(i => i.owner === o) })).sort((a, b) => b.list.length - a.list.length);
    const used = CATS.filter(c => iss.some(i => i.cat === c)), max = owners[0].list.length;
    const who = o => { const u = S.team.users.find(x => x.name === o); return `${u ? avatar(u, 22) + ' ' : ''}<b>${esc(o)}</b>`; };
    return `<div class="card" style="margin-bottom:16px"><h3>Tasks by owner and type</h3>
        <div class="muted" style="margin-bottom:10px">Each task goes to the owner of the system its item belongs to. Where a system has no owner, the task goes up to its parent’s owner and finally to the top-level system owner.</div>
        ${owners.map(({ o, list }) => `<div class="vbar"><a href="#own-${esc(encodeURIComponent(o))}" class="vbar-who">${who(o)}</a>
          <div class="vbar-track"><div class="vbar-fill" style="width:${100 * list.length / max}%">${used.map(c => { const n = list.filter(i => i.cat === c).length; return n ? `<i class="cat-${CATS.indexOf(c)}" style="flex:${n}" title="${esc(c)}: ${n}">${n}</i>` : ''; }).join('')}</div></div><span class="vbar-n">${list.length}</span></div>`).join('')}
        <div class="legend">${used.map(c => `<span><span class="dot cat-${CATS.indexOf(c)}"></span>${esc(c)}</span>`).join('')}</div></div>
      ${owners.map(({ o, list }) => `<div class="vsec" id="own-${esc(encodeURIComponent(o))}"><h3>${who(o)} <span class="muted">· ${plural(list.length, 'task')}</span></h3>
        <div class="reqs">${list.map(i => `<button class="issue" data-act="open" data-id="${esc(i.id)}"><span class="chip cat cat-${CATS.indexOf(i.cat)}">${esc(i.cat)}</span><span class="ref">${esc(i.id)}</span><span>${esc(i.message)}</span></button>`).join('')}</div></div>`).join('')}`;
  }

  function teamView(p) {
    if (!S.team.teams.length) return '<div class="card empty">This model has no team.json.</div>';
    const mine = p && p.team;
    return `<div class="card" style="margin-bottom:16px"><h3>Access by team</h3>
        <div class="scroll"><table class="access"><tr><th></th>${S.team.teams.map(t => `<th class="${t.key === mine ? 'me' : ''}"><span class="dot" style="background:${teamColor(t.key)}"></span>${esc(t.name)}</th>`).join('')}</tr>
        ${areas().map(a => `<tr><th><span class="mono">${esc(a.short)}</span> ${esc(a.name)}</th>${S.team.teams.map(t => { const v = t.access[a.key] || 'none'; return `<td class="a-${v} ${t.key === mine ? 'me' : ''}">${v === 'none' ? '–' : esc(v)}</td>`; }).join('')}</tr>`).join('')}</table></div>
        <div class="legend"><span><b>own</b>: edits, and is the required reviewer</span><span><b>write</b>: edits through pull requests</span><span><b>read</b>: sees but cannot change</span><span><b>–</b>: the area is hidden</span></div>
      </div>
      <div class="grid people">${S.team.teams.map(t => `<div class="card"><h3><span class="dot" style="background:${teamColor(t.key)}"></span>${esc(t.name)}</h3>
        ${S.team.users.filter(u => u.team === t.key).map(u => `<div class="person ${u.login === S.persona ? 'on' : ''}">${avatar(u, 32)}<div><b>${esc(u.name)}</b><div class="muted">${esc(u.role)}</div></div>
          <button class="btn ghost" data-act="persona" data-login="${esc(u.login === S.persona ? '' : u.login)}">${u.login === S.persona ? 'Stop' : 'Act as'}</button></div>`).join('')}</div>`).join('')}</div>
      <div class="banner" style="margin-top:16px">These people and rules are a simulation defined in <span class="mono">${esc(S.root)}/team.json</span> and applied in this browser. On a real project the same table becomes CODEOWNERS entries and protected branches, with hidden areas kept in a separate repository.</div>`;
  }

  const show = v => Array.isArray(v) ? v.join(', ') : (v ?? '');
  function changesView(ch, iss, p) {
    if (!ch.length) return `<div class="card empty">No changes waiting. Open an item, edit it and choose “Save changes”.</div>`;
    const errs = iss.filter(i => i.severity === 'error').length;
    const denied = ch.filter(refused).map(c => c.id);
    const verb = { add: 'Add', mod: 'Update', del: 'Remove' };
    const msg = ['add', 'mod', 'del'].map(t => { const ids = ch.filter(c => c.type === t).map(c => c.id); return ids.length ? `${verb[t]} ${ids.join(', ')}` : ''; }).filter(Boolean).join('; ');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const who = (p ? p.login.split('.')[0] : S.user?.login || 'edit').replace(/[^\w-]/g, '');
    return `<div class="reqs">${ch.map(c => `<div class="change">
        <div class="change-head">${chip(c.type, { add: 'new', mod: 'edited', del: 'deleted' }[c.type])}<span class="ref">${esc(c.id)}</span><span class="path">${esc(c.path)}</span><button data-act="unstage" data-id="${esc(c.id)}">Discard</button></div>
        <dl class="diff">${M.fields(c.id, S.project).map(f => {
          const a = show(c.before?.[f.k]), b = show(c.data?.[f.k]);
          if (String(a) === String(b) || (c.type === 'del' && f.k !== 'title')) return '';
          return `<dt>${esc(f.k)}</dt><dd>${a !== '' ? `<del>${esc(a)}</del> ` : ''}${b !== '' ? `<ins>${esc(b)}</ins>` : ''}</dd>`;
        }).join('')}${c.type === 'mod' && JSON.stringify(c.before.checks || []) !== JSON.stringify(c.data.checks || []) ? `<dt>checking</dt><dd><ins>${esc(checkText(c.data) || 'comments changed')}</ins></dd>` : ''}</dl></div>`).join('')}</div>
      <form class="card commit-box" data-submit="commit" style="margin-top:16px">
        <h3 style="margin:0">Commit${p ? ` as ${esc(p.name)}` : ''}</h3>
        ${p ? `<div class="help">Git author: ${esc(p.name)} &lt;${esc(p.login)}@${esc(S.team.domain)}&gt; (simulated). Committer: ${esc(S.user?.login || 'you')}.</div>` : ''}
        ${denied.length ? `<div class="banner err" style="margin:0">${esc(p ? p.name : 'You')} cannot change ${esc(denied.join(', '))}. Discard those edits or switch person.</div>` : ''}
        ${errs ? `<div class="banner err" style="margin:0">The model has ${plural(errs, 'validation error')}. You can still commit, but the CI check on the repository will fail.</div>` : ''}
        <label class="field"><span>Message</span><textarea name="message" required>${esc(msg)}</textarea></label>
        <label class="radio"><input type="radio" name="target" value="pr" checked><span>Commit to a new branch and open a pull request into <span class="mono">${esc(S.branch)}</span><br>
          <input name="newBranch" value="se/${esc(who)}-${stamp}" spellcheck="false" aria-label="New branch name" class="mono inline-input"></span></label>
        <label class="radio"><input type="radio" name="target" value="direct"><span>Commit directly to <span class="mono">${esc(S.branch)}</span></span></label>
        <div><button class="btn" type="submit" ${canPush() && !denied.length && !S.committing ? '' : 'disabled'}>${S.committing ? 'Committing…' : `Commit ${plural(ch.length, 'file')}`}</button></div>
      </form>`;
  }

  /* ---------------- drawer ---------------- */
  function openReq(id) {
    if (!S.work.has(id) && !S.base.has(id)) { toast(id + ' is not an item that can be opened here.', true); return; }
    if (!canSee(id)) { toast('You do not have access to ' + id + '.', true); return; }
    S.sel = { id, isNew: false }; renderDrawer();
    $$('.req.sel').forEach(n => n.classList.remove('sel'));
    $$(`.req[data-id="${CSS.escape(id)}"]`).forEach(n => n.classList.add('sel'));
    const b = S.base.get(id);
    if (b && !S.hist[b.path]) {
      gh(`${R()}/commits?sha=${encodeURIComponent(S.branch)}&path=${encodeURIComponent(b.path)}&per_page=8`)
        .then(list => { S.hist[b.path] = list; if (S.sel?.id === id) { const h = $('#hist'); if (h) h.innerHTML = commitList(list) || '<span class="muted">No commits.</span>'; } })
        .catch(() => {});
    }
  }
  function fieldHtml(f, d, dis, code) {
    const v = d[f.k], name = esc(f.k), lbl = `<span>${esc(f.label)}</span>`;
    if (f.fixed) return v ? `<label class="field half"><span>${esc(f.label)}</span><input value="${esc(S.project.rds.aspect + v)}" disabled></label>` : '';
    if (f.type === 'text') return `<label class="field ${/^evidence/.test(f.k) ? 'half' : ''}"><span>${esc(f.label)}</span><input name="${name}" ${f.req ? 'required' : ''} value="${esc(v)}" ${dis}></label>`;
    if (f.k === 'system') {   // every system is offered, even to people who cannot open the breakdown; risks need an approved one
      const pbs = [...S.work.keys()].filter(x => M.codeOf(x) === 'PBS' && (code !== 'RSK' || get(x).status === 'approved' || x === v)).sort((a, b) => sysOf(a).localeCompare(sysOf(b)));
      return `<label class="field">${lbl}<select name="${name}" required ${dis}>${pbs.map(x => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(S.project.rds.aspect + sysOf(x))}${canSee(x) ? ' · ' + esc(get(x).title) : ''}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'area') return `<label class="field">${lbl}<textarea name="${name}" ${f.req ? 'required' : ''} ${dis}>${esc(v)}</textarea></label>`;
    if (f.type === 'num') return `<label class="field half">${lbl}<select name="${name}" ${dis}>${[1, 2, 3, 4, 5].map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}${f.labels ? ' · ' + esc(f.labels[o - 1] || '') : ''}</option>`).join('')}</select></label>`;
    if (f.groups && f.k === 'kind') return '';   // derived from the sub-type
    if (f.groups) return `<label class="field"><span>Interface type and sub-type</span><select name="${name}" ${dis}>${Object.entries(f.groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
    if (f.type === 'select') return `<label class="field half">${lbl}<select name="${name}" ${dis}>${f.req ? '' : '<option value="">–</option>'}${f.opts.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    const cands = f.to.flatMap(idsOf);
    if (f.type === 'link') {
      const extra = v && !cands.includes(v) ? `<option value="${esc(v)}" selected>${S.work.has(v) ? 'restricted' : esc(v) + ' (missing)'}</option>` : '';
      return `<label class="field">${lbl}<select name="${name}" ${dis}>${f.req ? '' : '<option value="">–</option>'}${extra}${cands.map(c => `<option value="${esc(c)}" ${c === v ? 'selected' : ''}>${esc(c)} · ${esc(get(c).title)}</option>`).join('')}</select></label>`;
    }
    const cur = v || [], hidden = cur.filter(t => S.work.has(t) && !canSee(t)), missing = cur.filter(t => !S.work.has(t));
    return `<div class="field">${lbl}<div class="checks">
      ${hidden.map(t => `<input type="hidden" name="${name}" value="${esc(t)}">`).join('')}
      ${hidden.length ? `<div class="muted" style="padding:5px 10px;font-size:12px">${plural(hidden.length, 'restricted link')} kept as is.</div>` : ''}
      ${missing.map(t => `<label><input type="checkbox" name="${name}" value="${esc(t)}" checked ${dis}><span class="ref" style="color:var(--red)">${esc(t)}</span><span>does not exist</span></label>`).join('')}
      ${cands.map(c => `<label data-sys="${esc(sysOf(c))}"><input type="checkbox" name="${name}" value="${esc(c)}" ${cur.includes(c) ? 'checked' : ''} ${dis}><span class="ref">${esc(c)}</span><span>${esc(get(c).title)}</span></label>`).join('') || (hidden.length || missing.length ? '' : '<div class="muted" style="padding:6px 10px">Nothing to link to yet.</div>')}
    </div></div>`;
  }
  /* Interface form rules: System B must be at System A's level, and only their requirements can be linked. */
  function intSync(form) {
    if (!form || !form.from) return;
    const a = form.from.value, lvl = a ? depthOf(a) : null;
    [...form.to.options].forEach(o => { o.disabled = !!o.value && (o.value === a || (lvl != null && depthOf(o.value) !== lvl)); });
    if (form.to.selectedOptions[0]?.disabled) form.to.value = [...form.to.options].find(o => !o.disabled && o.value)?.value || '';
    const ok = [a, form.to.value].filter(Boolean).map(x => sysOf(x));
    $$('label[data-sys]', form).forEach(l => { const show = ok.includes(l.dataset.sys); l.hidden = !show; if (!show) l.querySelector('input').checked = false; });
  }
  function renderDrawer() {
    const el = $('#drawer');
    if (S.dialog && S.repoInfo) { el.innerHTML = dialogHtml(); return; }
    if (!S.sel || !S.repoInfo) { el.innerHTML = ''; return; }
    const { id, isNew } = S.sel;
    const gone = !isNew && !S.work.has(id);
    const d = isNew ? S.sel.data : (get(id) || S.base.get(id).data);
    const b = S.base.get(id), t = T(id);
    const code = M.codeOf(id);
    const typeName = code === 'ASS' ? 'Assumption' : t === 'REQ' ? `${level(P(id)).name} requirement` : M.TYPES[t]?.name || 'Item';
    const sysPick = !isNew ? ''
      : code === 'PBS' ? `<label class="field"><span>${esc(S.project.rds.scheme)} designation for this level</span><input name="_code" required placeholder="e.g. KFA2" maxlength="8" spellcheck="false" style="text-transform:uppercase"></label>
        <div class="help">ISO 81346 structure: ${S.project.rds.letters.map((n, i) => `level ${i}: ${n} class letter${n > 1 ? 's' : ''}`).join(', ')}, each followed by a number. The full code is the parent’s code plus this designation.</div>`
      : code === 'INT' ? `<div class="help">An interface joins two systems at the same architectural level.</div>`
      : code === 'RSK' ? '<div class="help">Only approved systems can be chosen. Raise a risk at the lowest system it applies to; if it spans several sub-systems, raise it once against their parent.</div>' : '';
    const edit = canEdit(id) && !gone;
    const comment = !isNew && !gone && canComment(id), who = whoAmI();
    const checks = CHECKED.includes(t) && !isNew ? (d.checks || []) : null;
    const dis = edit ? '' : 'disabled';
    const changed = isNew || changes().some(c => c.id === id);
    const mine = isNew ? [] : issues().filter(i => i.id === id);
    const back = isNew || gone ? [] : backlinks(id);
    el.innerHTML = `<div class="scrim" data-act="close"></div>
      <form class="drawer" data-submit="stage" role="dialog" aria-label="${esc(typeName)} ${esc(id)}">
        <div class="drawer-head"><h2>${isNew ? 'New' : esc(id)}</h2><span class="eyebrow">${esc(typeName)}</span>
          ${isNew ? chip('add', 'new') : gone ? chip('del', 'deleted') : changed ? chip('mod', b ? 'edited' : 'new') : ''}
          <button type="button" class="x" data-act="close" aria-label="Close">×</button></div>
        <div class="drawer-body">
          ${!edit && canPush() && !gone ? `<div class="mini-issue">${esc(me()?.name || 'You')} can read this but not change it.</div>` : ''}
          ${mine.map(i => `<div class="mini-issue ${i.severity}">${esc(i.message)}</div>`).join('')}
          ${sysPick}
          <div class="fields">${M.fields(id, S.project).map(f => fieldHtml(f, d, dis, code)).join('')}</div>
          ${checks ? `<div class="checking"><div class="section-lbl" style="margin-bottom:6px">Checking</div>
            ${checks.map((c, i) => `<div class="check ${c.closedBy ? 'closed' : ''}"><div class="check-meta"><b>${esc(c.by)}</b> · ${esc(when(c.date))}${c.closedBy ? ` · closed by ${esc(c.closedBy)}, ${esc(when(c.closedDate))}` : ''}</div>
              <div>${esc(c.text)}</div>${c.reply ? `<div class="muted">Close-out: ${esc(c.reply)}</div>` : ''}
              ${!c.closedBy && comment ? `<label class="checkline"><input type="checkbox" name="_close" value="${i}"> Close this comment</label>` : ''}</div>`).join('') || '<div class="muted" style="font-size:12.5px">No checking comments.</div>'}
            ${comment ? `${checks.some(c => !c.closedBy) ? `<input name="_reply" placeholder="Close-out note for the comments ticked above (optional)" class="inline-input" style="width:100%">` : ''}
              <textarea name="_check" placeholder="Add a checking comment. It will be stamped ${esc(who)}, ${esc(when(new Date().toISOString()))}." style="width:100%;margin-top:6px;min-height:56px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px"></textarea>` : ''}
          </div>` : ''}
          ${!isNew ? `<div><div class="section-lbl" style="margin-bottom:6px">Referenced by</div>${back.map(refbtn).join('') || '<span class="muted" style="font-size:12.5px">Nothing links to this yet.</span>'}</div>` : ''}
          ${b ? `<div><div class="section-lbl" style="margin-bottom:2px">File history</div><div class="mono muted" style="font-size:10.5px;overflow-wrap:anywhere">${esc(b.path)}</div><div id="hist">${S.hist[b.path] ? commitList(S.hist[b.path]) : '<span class="muted" style="font-size:12px">Loading…</span>'}</div></div>` : ''}
        </div>
        <div class="drawer-foot">
          ${edit || comment ? `<button class="btn" type="submit">${isNew ? 'Save' : edit ? 'Save changes' : 'Save comment'}</button>` : ''}
          ${!isNew && changed && canPush() ? `<button type="button" class="btn ghost" data-act="unstage" data-id="${esc(id)}">${gone ? 'Restore' : 'Discard edits'}</button>` : ''}
          ${edit && !isNew ? `<button type="button" class="btn danger" data-act="delete" data-id="${esc(id)}">Delete</button>` : ''}
          ${b ? `<a class="btn ghost" style="margin-left:auto;text-decoration:none" href="${webUrl()}/blob/${encRef(S.branch)}/${encRef(b.path)}" target="_blank" rel="noopener">View file</a>` : ''}
        </div>
      </form>`;
    if (isNew) $('[name=title]', el)?.focus();
    if (code === 'INT') intSync($('form', el));
  }

  /* ---------------- actions ---------------- */
  const run = p => Promise.resolve(p).catch(e => {
    if (e.status === 401) { S.error = 'GitHub rejected the token. Check that it has not expired.'; signOut(); return; }
    if (!S.head) { S.error = e.message; S.loading = ''; S.repoInfo = null; render(); return; }
    S.loading = ''; S.committing = false; render(); toast(e.message, true);
  });
  function setPersona(login) {
    S.persona = login || ''; ls.set('se.persona', S.persona);
    S.sel = null; fixView(); render(); renderDrawer();
    const p = me();
    toast(p ? `Now acting as ${p.name} (${teamOf(p).name}).` : 'Back to your own access.');
  }

  const actions = {
    view(t) { S.view = t.dataset.view; S.stamp = null; S.sel = null; S.q = ''; S.f = {}; S.colsOpen = false; fixView(); renderDrawer(); render(); window.scrollTo(0, 0); },
    level(t) { S.level = t.dataset.level; S.q = ''; S.f = {}; render(); },
    sort(t) {
      const g = S.grid[t.dataset.grid] = S.grid[t.dataset.grid] || {}, k = t.dataset.k;
      g.sort = g.sort?.k !== k ? { k, dir: 1 } : g.sort.dir > 0 ? { k, dir: -1 } : null;
      ls.set('se.grid', S.grid); render();
    },
    spec(t) {
      if (!t.dataset.stay && RANK[acc('requirements/' + leaf())] < 1) { toast(`You do not have access to ${leaf()} requirements.`, true); return; }
      S.spec = t.dataset.id;
      if (t.dataset.stay) { render(); return; }
      S.view = 'app:REQ'; S.level = leaf(); S.q = ''; S.f = {}; S.sel = null; renderDrawer(); render(); window.scrollTo(0, 0);
    },
    zoom(t) { S.zoom = +t.dataset.z; render(); },
    print() { window.print(); },
    csv() { exportCsv(); },
    export(t) { S.dialog = { kind: 'export', format: t.dataset.format }; renderDrawer(); },
    baselines() { S.dialog = { kind: 'baselines' }; renderDrawer(); },
    closeDialog() { S.dialog = null; renderDrawer(); },
    openBaseline(t) { run(openBaseline(S.exports[+t.dataset.i])); },
    intLevel(t) { S.intLevel = t.dataset.l; S.q = ''; render(); },
    mdim(t) { S.mdim = t.dataset.d; render(); },
    colsAll(t) { (S.grid[t.dataset.grid] = S.grid[t.dataset.grid] || {}).hidden = []; S.colsOpen = true; ls.set('se.grid', S.grid); render(); },
    colsReset(t) { delete (S.grid[t.dataset.grid] || {}).hidden; S.colsOpen = true; ls.set('se.grid', S.grid); render(); },
    open(t) { openReq(t.dataset.id); },
    close() { S.sel = null; renderDrawer(); $$('.req.sel').forEach(n => n.classList.remove('sel')); },
    persona(t) { setPersona(t.dataset.login); },
    new(t) {
      const code = t.dataset.prefix, id = code + '-000', data = {};
      M.fields(id, S.project).forEach(f => { data[f.k] = f.type === 'links' ? [] : f.type === 'num' ? 3 : f.type === 'select' && f.req ? f.opts[0] : ''; });
      if ('system' in data) data.system = S.spec && S.work.has(S.spec) ? S.spec : ([...S.work.keys()].filter(x => M.codeOf(x) === 'PBS').sort((a, b) => sysOf(a).localeCompare(sysOf(b)))[0] || '');
      if (code === 'RSK' && get(data.system)?.status !== 'approved') data.system = [...S.work.keys()].filter(x => M.codeOf(x) === 'PBS' && get(x).status === 'approved').sort((x, y) => sysOf(x).localeCompare(sysOf(y)))[0] || '';
      if (code === 'ASS') data.stability = M.fields(id, S.project).find(f => f.k === 'stability').opts[0];
      S.sel = { id, isNew: true, code, data }; renderDrawer();
    },
    unstage(t) {
      const id = t.dataset.id, b = S.base.get(id);
      b ? S.work.set(id, clone(b.data)) : S.work.delete(id);
      saveDraft(); if (S.sel?.id === id && !b) S.sel = null;
      render(); renderDrawer();
    },
    delete(t) {
      const id = t.dataset.id, refs = backlinks(id);
      if (!confirm(`Delete ${id}?` + (refs.length ? `\n\n${refs.join(', ')} link to it and will be flagged by validation.` : ''))) return;
      S.work.delete(id); saveDraft(); S.sel = null; render(); renderDrawer();
      toast(`${id} will be deleted when you commit.`);
    },
    reload() { run(loadBranch(S.branch)); },
    signout() { signOut(); }
  };

  const submits = {
    export(f) { run(doExport(f.format.value, f.type ? f.type.value : '', f.description ? f.description.value.trim() : '')); },
    connect(f) {
      S.token = f.token.value.trim();
      saveToken(S.token, f.remember.checked);
      S.head = null;
      const cfg = ls.get('se.cfg', {});
      run(connect(f.repo.value, f.root.value, new URLSearchParams(location.search).get('branch') || (cfg.repo === f.repo.value.trim() ? cfg.branch : '')));
    },
    stage(f) {
      const { isNew, code } = S.sel, fake = S.sel.id;
      let id = fake;
      let newCode = '';
      if (isNew) {
        if (code === 'PBS') {
          const seg = f._code.value.trim().toUpperCase(), par = f.parent.value, depth = par ? depthOf(par) + 1 : 0, n = S.project.rds.letters[Math.min(depth, S.project.rds.letters.length - 1)];
          if (!new RegExp(`^[A-Z]{${n}}[1-9]\\d*$`).test(seg)) { toast(`A level ${depth} designation is ${n} class letter${n > 1 ? 's' : ''} followed by a number, for example ${'ABC'.slice(0, n)}1.`, true); return; }
          newCode = par ? `${sysOf(par)}.${seg}` : seg;
          if ([...S.work.keys(), ...S.base.keys()].some(x => M.codeOf(x) === 'PBS' && sysOf(x) === newCode)) { toast(`${S.project.rds.aspect}${newCode} is already in use.`, true); return; }
        } else if (code === 'INT' && (!f.from.value || !f.to.value || depthOf(f.from.value) !== depthOf(f.to.value))) { toast('Choose two systems at the same architectural level.', true); return; }
        id = M.makeId(S.project, code, nextNum(code));
      }
      const data = isNew ? {} : clone(get(id));
      data.id = id;
      if (newCode) data.code = newCode;
      if (isNew || canEdit(id)) M.fields(fake, S.project).forEach(fd => {
        if (fd.fixed) return;
        if (fd.type === 'links') data[fd.k] = $$(`input[name="${fd.k}"]`, f).filter(i => i.type === 'hidden' || i.checked).map(i => i.value);
        else if (f[fd.k]) data[fd.k] = fd.type === 'num' ? Number(f[fd.k].value) : f[fd.k].value.trim();
      });
      if (code === 'INT') data.kind = Object.keys(S.project.interfaceTypes).find(g => S.project.interfaceTypes[g].includes(data.subtype)) || data.kind;
      // checking comments are stamped with who and when, and are never edited afterwards
      const now = new Date().toISOString();
      $$('[name=_close]:checked', f).forEach(i => { const c = data.checks[+i.value]; c.closedBy = whoAmI(); c.closedDate = now; if (f._reply?.value.trim()) c.reply = f._reply.value.trim(); });
      if (f._check?.value.trim()) (data.checks = data.checks || []).push({ by: whoAmI(), date: now, text: f._check.value.trim() });
      S.work.set(id, data); saveDraft();
      S.sel = null; render(); renderDrawer();
      toast(changes().some(c => c.id === id) ? `${id} saved. Commit it from Changes.` : `${id} matches the committed version.`);
    },
    commit(f) {
      const direct = f.target.value === 'direct';
      const nb = f.newBranch.value.trim();
      if (!direct && (!/^[\w.\-/]+$/.test(nb) || S.branches.includes(nb))) { toast('Choose a new branch name that is not already in use (letters, digits, / . - _).', true); return; }
      run(commit(f.message.value.trim(), direct ? '' : nb));
    }
  };

  document.addEventListener('click', e => {
    const sum = e.target.closest('.cols > summary');
    if (sum) S.colsOpen = !sum.parentElement.open;
    else if (S.colsOpen && !e.target.closest('.cols')) { S.colsOpen = false; $$('.cols[open]').forEach(d => { d.open = false; }); }
    const t = e.target.closest('[data-act]');
    if (t && actions[t.dataset.act]) { if (t.tagName !== 'A') e.preventDefault(); actions[t.dataset.act](t); }
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-submit]');
    if (f) { e.preventDefault(); submits[f.dataset.submit](f); }
  });
  document.addEventListener('change', e => {
    const k = e.target.dataset.change;
    if (k === 'branch') run(loadBranch(e.target.value));
    if (k === 'persona') setPersona(e.target.value);
    if (k === 'filter') { S.f[e.target.dataset.f] = e.target.value; render(); }
    if (k === 'spec') { S.spec = e.target.value; render(); }
    if (k === 'specDepth') { S.specDepth = e.target.value; render(); }
    if (['from', 'to'].includes(e.target.name) && e.target.closest('.drawer')) intSync(e.target.form);
    if (k === 'col') {
      const key = e.target.dataset.grid, g = S.grid[key] = S.grid[key] || {};
      const hidden = new Set(S.lastGrid.cols.filter(c => colHidden(key, c)).map(c => c.k));
      e.target.checked ? hidden.delete(e.target.dataset.k) : hidden.add(e.target.dataset.k);
      g.hidden = [...hidden]; S.colsOpen = true; ls.set('se.grid', S.grid); render();
    }
  });
  document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; render(); } });
  document.addEventListener('mouseover', e => { if (S.view === 'trace') highlight(e.target.closest('[data-node]')?.dataset.node || null); });
  document.addEventListener('focusin', e => { if (S.view === 'trace' && e.target.dataset?.node) highlight(e.target.dataset.node); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.dialog) actions.closeDialog();
    else if (e.key === 'Escape' && S.sel) actions.close();
    if (e.key === 'Enter' && e.target.matches('tr[data-act]')) e.target.click();
  });
  window.addEventListener('resize', () => { if (S.view === 'trace') drawTrace(); });

  /* ---------------- boot ---------------- */
  S.token = loadToken();
  const cfg = ls.get('se.cfg', {});
  const params = new URLSearchParams(location.search);
  const repo = params.get('repo') || cfg.repo;
  if (repo && (S.token || params.get('repo'))) run(connect(repo, params.get('root') || cfg.root, params.get('branch') || cfg.branch));
  else render();
})();
