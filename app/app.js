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
    { key: 'REQ', name: 'Requirements', blurb: 'What stakeholders, users and the system must do, traced level to level.' },
    { key: 'CMP', name: 'Architecture', blurb: 'Product breakdown, with system requirements allocated to components.' },
    { key: 'IF', name: 'Interfaces', blurb: 'Interface register and an N² view of what connects to what.' },
    { key: 'VER', name: 'Verification', blurb: 'Verification cases, their results and requirement coverage.' },
    { key: 'RSK', name: 'Risks', blurb: 'Risk register on a likelihood × impact matrix.' },
    { key: 'DEC', name: 'Decisions', blurb: 'Design decisions, the options weighed and what they affect.' }
  ];
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
    view: 'hub', level: '', q: '', statusF: '', sel: null, hist: {}, loading: '', error: '', committing: false
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
  const canPush = () => !!(S.token && S.repoInfo && S.repoInfo.permissions && S.repoInfo.permissions.push);

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
    const readJson = name => {
      const f = all.find(x => x.rel === name);
      if (!f) return {};
      try { return JSON.parse(f.text); } catch { toast(name + ' is not valid JSON; using defaults.', true); return {}; }
    };
    S.project = M.project(readJson('project.json'));
    const team = readJson('team.json');
    S.team = { teams: team.teams || [], users: team.users || [], domain: team.domain || 'example.invalid' };
    if (!S.team.users.some(u => u.login === S.persona)) S.persona = '';
    S.commits = commits; S.hist = {};
    S.base = new Map(); S.bad = [];
    all.filter(f => M.isItemPath(f.rel, S.project)).forEach(f => {
      const entry = { path: `${S.root}/${f.rel}`, rel: f.rel, sha: f.sha, data: null };
      try { entry.data = JSON.parse(f.text); } catch (e) { entry.parseError = e.message; }
      if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) S.base.set(f.rel.replace(/^.*\//, '').replace(/\.json$/, ''), entry);
      else S.bad.push(entry);
    });
    S.work = new Map([...S.base].map(([id, e]) => [id, clone(e.data)]));
    const draft = ls.get(draftKey(), {});
    for (const id in draft) draft[id] === null ? S.work.delete(id) : S.work.set(id, draft[id]);
    S.loading = '';
    fixView();
    render();
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
  const canEditPrefix = p => canEdit(p + '-000');

  /* ---------------- model helpers ---------------- */
  const draftKey = () => `se.draft:${S.owner}/${S.repo}@${S.branch}`;
  const T = id => M.typeOf(id, S.project);
  const level = key => S.project.levels.find(l => l.key === key);
  const leaf = () => M.leafKey(S.project);
  const idsOf = prefix => [...S.work.keys()].filter(id => M.prefixOf(id) === prefix && canSee(id)).sort();
  const get = id => S.work.get(id);
  const ser = d => M.serialize(d, S.project);
  /* Every (field, target) link an item holds. */
  const linksOf = (id, d) => M.fields(id, S.project).filter(f => f.type === 'link' || f.type === 'links')
    .flatMap(f => (f.type === 'link' ? [d[f.k]] : d[f.k] || []).filter(Boolean).map(t => ({ field: f, to: t })));
  const backlinks = id => [...S.work].filter(([oid, d]) => oid !== id && canSee(oid) && linksOf(oid, d).some(l => l.to === id)).map(([oid]) => oid).sort();
  const linking = (prefix, key, id) => idsOf(prefix).filter(o => [].concat(get(o)[key] || []).includes(id));
  const childLevel = key => S.project.levels.find(l => l.parent === key);
  const childrenOf = id => { const c = childLevel(M.prefixOf(id)); return c ? linking(c.key, 'traces', id) : []; };
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
  function nextId(prefix) {
    const nums = [...S.work.keys(), ...S.base.keys()].filter(id => M.prefixOf(id) === prefix).map(id => parseInt(id.split('-')[1], 10) || 0);
    return prefix + '-' + String(Math.max(0, ...nums) + 1).padStart(3, '0');
  }
  function fixView() {
    const app = S.view.startsWith('app:') && S.view.slice(4);
    const known = ['hub', 'trace', 'validation', 'team', 'changes', 'history'].includes(S.view) || APPS.some(a => a.key === app);
    if (!known || (app && appAcc(app) === 'none')) S.view = 'hub';
    if (!visLevels().some(l => l.key === S.level)) S.level = visLevels()[0]?.key || '';
  }

  /* ---------------- commit ---------------- */
  async function commit(message, newBranch) {
    const ch = changes();
    if (!ch.length) return;
    const p = me();
    const denied = ch.filter(c => !canEdit(c.id)).map(c => c.id);
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
  const TONES = { grey: ['draft', 'planned', 'proposed', 'open'], amber: ['review', 'mitigating', 'agreed', 'blocked'], green: ['approved', 'passed', 'accepted', 'baselined', 'closed'], red: ['obsolete', 'failed', 'superseded'] };
  const tone = s => Object.keys(TONES).find(t => TONES[t].includes(s)) || 'grey';
  const dot = s => `<span class="dot t-${tone(s)}"></span>`;
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
  const match = (id, d) => { const q = S.q.trim().toLowerCase(); return !q || [id, d.title, d.text, d.description].join(' ').toLowerCase().includes(q); };
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

  function mainView(iss, ch, p) {
    const top = (title, sub, right = '') => `<div class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="spacer"></div>${right}
      ${ch.length && S.view !== 'changes' ? `<button class="btn amber" data-act="view" data-view="changes">Review ${plural(ch.length, 'change')}</button>` : ''}</div>`;
    const ro = canPush() ? '' : `<div class="banner">${S.token ? 'Your GitHub account cannot push to this repository, so everything is read-only.' : 'Browsing without a token: everything is read-only.'}</div>`;
    const app = S.view.startsWith('app:') ? S.view.slice(4) : '';
    const accNote = app && p ? `<div class="banner sim">${avatar(p, 20)} <b>${esc(p.name)}</b> · ${esc(teamOf(p).name)}: ${esc(ACC_LABEL[appAcc(app)].toLowerCase())} here.</div>` : '';
    if (S.view === 'hub') return top(S.project.name, esc(S.project.description || '')) + ro + hubView(iss, ch, p);
    if (S.view === 'trace') return top('Trace', 'Hover an item to follow its chain from stakeholder need to verification.') + traceView(iss);
    if (S.view === 'validation') return top('Validation', 'Schema and link checks, run in the browser on every edit and in CI on every push.') + validationView(iss);
    if (S.view === 'team') return top('Team and access', 'Who is on the project and what each team may see or change.') + teamView(p);
    if (S.view === 'changes') return top('Changes', `Staged edits on <span class="mono">${esc(S.branch)}</span>, kept in this browser until committed.`) + ro + changesView(ch, iss, p);
    if (S.view === 'history') return top('History', `Commits touching <span class="mono">${esc(S.root)}/</span> on <span class="mono">${esc(S.branch)}</span>.`) + `<div class="card">${commitList(S.commits) || '<div class="empty">No commits found.</div>'}</div>`;
    const a = APPS.find(x => x.key === app);
    const right = { REQ: () => newBtn(S.level, S.level), CMP: () => newBtn('CMP', 'component'), IF: () => newBtn('IF', 'interface'), VER: () => newBtn('VER', 'case'), RSK: () => newBtn('RSK', 'risk'), DEC: () => newBtn('DEC', 'decision') }[app]();
    return top(a.name, esc(a.blurb), right) + ro + accNote + appViews[app](iss, ch);
  }

  /* ---------------- hub ---------------- */
  function appStat(k) {
    if (k === 'REQ') {
      const all = visLevels().flatMap(l => idsOf(l.key));
      const lower = all.filter(id => level(M.prefixOf(id)).parent && get(id).status !== 'obsolete');
      return [plural(all.length, 'requirement'), `${pct(lower.filter(id => (get(id).traces || []).length).length, lower.length)} traced upward`];
    }
    const list = idsOf(k), n = v => list.filter(id => v(get(id))).length;
    if (k === 'CMP') { const sys = idsOf(leaf()); return [plural(list.length, 'component'), sys.length ? `${sys.filter(id => linking('CMP', 'allocated', id).length).length}/${sys.length} ${leaf()} allocated` : '']; }
    if (k === 'IF') return [plural(list.length, 'interface'), `${n(d => d.status === 'baselined')} baselined, ${n(d => d.status === 'draft')} draft`];
    if (k === 'VER') return [plural(list.length, 'case'), `${n(d => d.result === 'passed')} passed, ${n(d => d.result === 'failed')} failed`];
    if (k === 'RSK') return [`${n(d => d.status !== 'closed')} active risks`, `${n(d => d.status !== 'closed' && d.likelihood * d.impact >= 12)} high`];
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
        <button class="card tile" data-act="view" data-view="validation"><span class="tile-head"><b>Validation</b>${iss.length ? chip(errs ? 'error' : 'warn', errs ? plural(errs, 'error') : plural(iss.length, 'warning')) : chip('add', 'clean')}</span><span class="tile-blurb">Model checks that also run in CI.</span></button>
        <button class="card tile" data-act="view" data-view="changes"><span class="tile-head"><b>Changes</b>${ch.length ? chip('mod', ch.length + ' staged') : ''}</span><span class="tile-blurb">Review staged edits, then commit or open a pull request.</span></button>
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

  /* ---------------- item rows ---------------- */
  function row(id, iss, ch, depth = 0) {
    const gone = !S.work.has(id);
    const d = gone ? S.base.get(id).data : get(id);
    const c = ch.find(x => x.id === id), mine = iss.filter(i => i.id === id), t = T(id);
    let body = '', links = '', side = '';
    if (t === 'REQ') {
      const l = level(M.prefixOf(id)), child = childLevel(l.key), kids = gone ? [] : childrenOf(id);
      body = d.text;
      links = (l.parent ? `↑ ${refText(d.traces || []) || '<span class="amber">no parent</span>'}<br>` : '') +
        (child ? `↓ ${kids.length ? kids.length + ' ' + esc(child.key) : '<span class="amber">not covered</span>'}` : (d.verification ? 'verify: ' + esc(d.verification) : ''));
      side = st(d.status) + `<span class="muted">${esc(d.priority)}</span>`;
    } else if (t === 'CMP') {
      body = d.description;
      links = `${(d.allocated || []).length} allocated<br>${idsOf('IF').filter(i => get(i).from === id || get(i).to === id).length} interfaces`;
      side = chip('', d.kind);
    } else if (t === 'IF') {
      body = d.description; links = `${refText([d.from])} → ${refText([d.to])}<br>${refText(d.requirements || [])}`;
      side = st(d.status) + `<span class="muted">${esc(d.kind)}</span>`;
    } else if (t === 'VER') {
      body = d.procedure; links = `verifies ${refText(d.verifies || []) || '<span class="amber">nothing</span>'}`;
      side = st(d.result) + `<span class="muted">${esc(d.method)}</span>`;
    } else if (t === 'RSK') {
      body = d.description; links = `L${esc(d.likelihood)} × I${esc(d.impact)} = <b>${d.likelihood * d.impact}</b><br>${esc(d.owner || '')}`;
      side = st(d.status);
    } else {
      body = d.decision || d.context; links = `affects ${refText(d.affects || [])}`; side = st(d.status);
    }
    return `<button class="req ${c ? 'changed' : ''} ${gone ? 'gone' : ''} ${S.sel?.id === id ? 'sel' : ''}" data-act="open" data-id="${esc(id)}">
      <span class="ref" style="padding-left:${depth * 14}px">${depth ? '└ ' : ''}${esc(id)}</span>
      <span><div class="req-title">${esc(d.title)}</div><div class="req-text">${esc(body)}</div></span>
      <span class="req-links">${links}</span>
      <span class="req-side">${side}${c ? chip(c.type, { add: 'new', mod: 'edited', del: 'deleted' }[c.type]) : ''}${mine.length ? chip(mine[0].severity, plural(mine.length, mine[0].severity === 'error' ? 'error' : 'warning')) : ''}</span>
    </button>`;
  }
  function listOf(prefix, iss, ch, { filter, sort } = {}) {
    const deleted = ch.filter(c => c.type === 'del' && M.prefixOf(c.id) === prefix && canSee(c.id)).map(c => c.id);
    let list = [...idsOf(prefix), ...deleted].sort().filter(id => { const d = get(id) || S.base.get(id).data; return match(id, d) && (!filter || filter(d)); });
    if (sort) list = list.sort(sort);
    return `<div class="reqs">${list.map(id => row(id, iss, ch)).join('') || `<div class="empty">${S.q ? 'Nothing matches the search.' : 'Nothing here yet.'}</div>`}</div>`;
  }

  /* ---------------- apps ---------------- */
  const appViews = {
    REQ(iss, ch) {
      const l = level(S.level);
      if (!l) return '<div class="card empty">No requirement level is visible to you.</div>';
      return `<div class="tabs">${S.project.levels.map(x => RANK[acc('requirements/' + x.key)] >= 1
          ? `<button data-act="level" data-level="${esc(x.key)}" class="${x.key === l.key ? 'on' : ''}"><span class="mono">${esc(x.key)}</span> ${esc(x.name)} <span class="count">${idsOf(x.key).length}</span></button>`
          : `<button disabled><span class="mono">${esc(x.key)}</span> ${esc(x.name)} <span class="count">locked</span></button>`).join('')}</div>
        <div class="tools">${search(`${l.key} by ID, title or text`)}
          <select data-change="statusF" aria-label="Status filter"><option value="">All statuses</option>${S.project.statuses.map(s => `<option ${S.statusF === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        ${listOf(l.key, iss, ch, { filter: d => !S.statusF || d.status === S.statusF })}`;
    },
    CMP(iss, ch) {
      const all = idsOf('CMP'), seen = new Set();
      const walk = (id, depth) => { if (seen.has(id)) return ''; seen.add(id); return (match(id, get(id)) ? row(id, iss, ch, depth) : '') + all.filter(c => get(c).parent === id).map(c => walk(c, depth + 1)).join(''); };
      const roots = all.filter(id => !all.includes(get(id).parent));
      const html = roots.map(r => walk(r, 0)).join('') + all.filter(id => !seen.has(id)).map(id => walk(id, 0)).join('');
      const sys = idsOf(leaf()), un = sys.filter(id => !linking('CMP', 'allocated', id).length && get(id).status !== 'obsolete');
      return `<div class="tools">${search('components')}</div>
        <div class="reqs">${html || '<div class="empty">No components yet.</div>'}</div>
        ${sys.length ? `<div class="card" style="margin-top:16px"><h3>Allocation of ${esc(leaf())} requirements</h3>
          <div class="muted" style="margin-bottom:8px">${sys.length - un.length} of ${sys.length} allocated to a component.</div>
          ${un.length ? `<div class="section-lbl" style="margin-bottom:6px">Not allocated</div>${un.map(refbtn).join('')}` : ''}</div>` : ''}`;
    },
    IF(iss, ch) {
      const ifs = idsOf('IF'), comps = idsOf('CMP').filter(c => ifs.some(i => get(i).from === c || get(i).to === c));
      const n2 = comps.length ? `<div class="card" style="margin-bottom:16px"><h3>N² view</h3><div class="muted" style="margin-bottom:10px">Components on the diagonal. An interface sits in the row of its source and the column of its destination.</div>
        <div class="scroll"><table class="n2">${comps.map(r => `<tr>${comps.map(c => r === c
          ? `<th><button class="linkish dark" data-act="open" data-id="${esc(r)}"><span class="mono">${esc(r)}</span><br>${esc(get(r).title)}</button></th>`
          : `<td>${ifs.filter(i => get(i).from === r && get(i).to === c).map(refbtn).join('')}</td>`).join('')}</tr>`).join('')}</table></div></div>` : '';
      return n2 + `<div class="tools">${search('interfaces')}</div>${listOf('IF', iss, ch)}${legend(['draft', 'agreed', 'baselined'])}`;
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
        <div class="tools">${search('verification cases')}</div>${listOf('VER', iss, ch)}${legend(['planned', 'blocked', 'passed', 'failed'])}`;
    },
    RSK(iss, ch) {
      const live = idsOf('RSK').filter(id => get(id).status !== 'closed');
      const cell = (l, i) => { const s = l * i; return `<td class="${s >= 12 ? 'hi' : s >= 6 ? 'mid' : 'lo'}">${live.filter(id => get(id).likelihood === l && get(id).impact === i).map(refbtn).join('')}</td>`; };
      return `<div class="card" style="margin-bottom:16px"><h3>Likelihood × impact</h3><div class="muted" style="margin-bottom:10px">Active risks only. Closed risks stay in the register below.</div>
          <div class="scroll"><table class="heat"><tr><th></th>${[1, 2, 3, 4, 5].map(i => `<th>Impact ${i}</th>`).join('')}</tr>
          ${[5, 4, 3, 2, 1].map(l => `<tr><th>Likelihood ${l}</th>${[1, 2, 3, 4, 5].map(i => cell(l, i)).join('')}</tr>`).join('')}</table></div></div>
        <div class="tools">${search('risks')}</div>
        ${listOf('RSK', iss, ch, { sort: (a, b) => { const s = x => { const d = get(x) || S.base.get(x).data; return d.likelihood * d.impact; }; return s(b) - s(a); } })}${legend(['open', 'mitigating', 'accepted', 'closed'])}`;
    },
    DEC(iss, ch) { return `<div class="tools">${search('decisions')}</div>${listOf('DEC', iss, ch)}${legend(['proposed', 'accepted', 'superseded'])}`; }
  };

  /* ---------------- trace ---------------- */
  const traceCols = () => [...visLevels().map(l => ({ key: l.key, name: l.name })), ...(RANK[acc('verification')] >= 1 ? [{ key: 'VER', name: 'Verification' }] : [])];
  const upOf = id => (get(id)?.traces || get(id)?.verifies || []).filter(t => S.work.has(t) && canSee(t));
  const downOf = id => [...childrenOf(id), ...(M.prefixOf(id) === leaf() ? linking('VER', 'verifies', id) : [])];
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

  /* ---------------- validation / team / changes ---------------- */
  function validationView(iss) {
    if (!iss.length) return `<div class="card empty">No issues in the parts of the model you can see.</div>`;
    return `<div class="reqs">${iss.map(i => `<button class="issue" data-act="open" data-id="${esc(i.id)}">${chip(i.severity, i.severity === 'warn' ? 'warning' : 'error')}<span class="ref">${esc(i.id)}</span><span>${esc(i.message)}</span></button>`).join('')}</div>`;
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
    if (!ch.length) return `<div class="card empty">No staged changes. Open an item, edit it and choose “Stage change”.</div>`;
    const errs = iss.filter(i => i.severity === 'error').length;
    const denied = ch.filter(c => !canEdit(c.id)).map(c => c.id);
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
        }).join('')}</dl></div>`).join('')}</div>
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
  function fieldHtml(f, d, dis) {
    const v = d[f.k], name = esc(f.k), lbl = `<span>${esc(f.label)}</span>`;
    if (f.type === 'text') return `<label class="field"><span>${esc(f.label)}</span><input name="${name}" ${f.req ? 'required' : ''} value="${esc(v)}" ${dis}></label>`;
    if (f.type === 'area') return `<label class="field">${lbl}<textarea name="${name}" ${f.req ? 'required' : ''} ${dis}>${esc(v)}</textarea></label>`;
    if (f.type === 'select' || f.type === 'num') {
      const opts = f.type === 'num' ? [1, 2, 3, 4, 5] : f.opts;
      return `<label class="field half">${lbl}<select name="${name}" ${dis}>${f.req ? '' : '<option value="">–</option>'}${opts.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
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
      ${cands.map(c => `<label><input type="checkbox" name="${name}" value="${esc(c)}" ${cur.includes(c) ? 'checked' : ''} ${dis}><span class="ref">${esc(c)}</span><span>${esc(get(c).title)}</span></label>`).join('') || (hidden.length || missing.length ? '' : '<div class="muted" style="padding:6px 10px">Nothing to link to yet.</div>')}
    </div></div>`;
  }
  function renderDrawer() {
    const el = $('#drawer');
    if (!S.sel || !S.repoInfo) { el.innerHTML = ''; return; }
    const { id, isNew } = S.sel;
    const gone = !isNew && !S.work.has(id);
    const d = isNew ? S.sel.data : (get(id) || S.base.get(id).data);
    const b = S.base.get(id), t = T(id);
    const typeName = t === 'REQ' ? `${level(M.prefixOf(id)).name} requirement` : M.TYPES[t]?.name || 'Item';
    const edit = canEdit(id) && !gone;
    const dis = edit ? '' : 'disabled';
    const changed = isNew || changes().some(c => c.id === id);
    const mine = isNew ? [] : issues().filter(i => i.id === id);
    const back = isNew || gone ? [] : backlinks(id);
    el.innerHTML = `<div class="scrim" data-act="close"></div>
      <form class="drawer" data-submit="stage" role="dialog" aria-label="${esc(typeName)} ${esc(id)}">
        <div class="drawer-head"><h2>${esc(id)}</h2><span class="eyebrow">${esc(typeName)}</span>
          ${isNew ? chip('add', 'new') : gone ? chip('del', 'deleted') : changed ? chip('mod', b ? 'edited' : 'new') : ''}
          <button type="button" class="x" data-act="close" aria-label="Close">×</button></div>
        <div class="drawer-body">
          ${!edit && canPush() && !gone ? `<div class="mini-issue">${esc(me()?.name || 'You')} can read this but not change it.</div>` : ''}
          ${mine.map(i => `<div class="mini-issue ${i.severity}">${esc(i.message)}</div>`).join('')}
          <div class="fields">${M.fields(id, S.project).map(f => fieldHtml(f, d, dis)).join('')}</div>
          ${!isNew ? `<div><div class="section-lbl" style="margin-bottom:6px">Referenced by</div>${back.map(refbtn).join('') || '<span class="muted" style="font-size:12.5px">Nothing links to this yet.</span>'}</div>` : ''}
          ${b ? `<div><div class="section-lbl" style="margin-bottom:2px">File history</div><div class="mono muted" style="font-size:10.5px;overflow-wrap:anywhere">${esc(b.path)}</div><div id="hist">${S.hist[b.path] ? commitList(S.hist[b.path]) : '<span class="muted" style="font-size:12px">Loading…</span>'}</div></div>` : ''}
        </div>
        <div class="drawer-foot">
          ${edit ? `<button class="btn" type="submit">${isNew ? 'Stage new item' : 'Stage change'}</button>` : ''}
          ${!isNew && changed && canPush() ? `<button type="button" class="btn ghost" data-act="unstage" data-id="${esc(id)}">${gone ? 'Restore' : 'Discard edits'}</button>` : ''}
          ${edit && !isNew ? `<button type="button" class="btn danger" data-act="delete" data-id="${esc(id)}">Delete</button>` : ''}
          ${b ? `<a class="btn ghost" style="margin-left:auto;text-decoration:none" href="${webUrl()}/blob/${encRef(S.branch)}/${encRef(b.path)}" target="_blank" rel="noopener">View file</a>` : ''}
        </div>
      </form>`;
    if (isNew) $('[name=title]', el)?.focus();
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
    view(t) { S.view = t.dataset.view; S.sel = null; S.q = ''; fixView(); renderDrawer(); render(); window.scrollTo(0, 0); },
    level(t) { S.level = t.dataset.level; S.q = ''; render(); },
    open(t) { openReq(t.dataset.id); },
    close() { S.sel = null; renderDrawer(); $$('.req.sel').forEach(n => n.classList.remove('sel')); },
    persona(t) { setPersona(t.dataset.login); },
    new(t) {
      const id = nextId(t.dataset.prefix), data = {};
      M.fields(id, S.project).forEach(f => { data[f.k] = f.type === 'links' ? [] : f.type === 'num' ? 3 : f.type === 'select' && f.req ? f.opts[0] : ''; });
      S.sel = { id, isNew: true, data }; renderDrawer();
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
      toast(`${id} staged for deletion.`);
    },
    reload() { run(loadBranch(S.branch)); },
    signout() { signOut(); }
  };

  const submits = {
    connect(f) {
      S.token = f.token.value.trim();
      saveToken(S.token, f.remember.checked);
      S.head = null;
      const cfg = ls.get('se.cfg', {});
      run(connect(f.repo.value, f.root.value, new URLSearchParams(location.search).get('branch') || (cfg.repo === f.repo.value.trim() ? cfg.branch : '')));
    },
    stage(f) {
      const { id, isNew } = S.sel;
      const data = isNew ? {} : clone(get(id));
      data.id = id;
      M.fields(id, S.project).forEach(fd => {
        if (fd.type === 'links') data[fd.k] = $$(`input[name="${fd.k}"]`, f).filter(i => i.type === 'hidden' || i.checked).map(i => i.value);
        else if (f[fd.k]) data[fd.k] = fd.type === 'num' ? Number(f[fd.k].value) : f[fd.k].value.trim();
      });
      S.work.set(id, data); saveDraft();
      S.sel = null; render(); renderDrawer();
      toast(changes().some(c => c.id === id) ? `${id} staged. Commit it from Changes.` : `${id} matches the committed version.`);
    },
    commit(f) {
      const direct = f.target.value === 'direct';
      const nb = f.newBranch.value.trim();
      if (!direct && (!/^[\w.\-/]+$/.test(nb) || S.branches.includes(nb))) { toast('Choose a new branch name that is not already in use (letters, digits, / . - _).', true); return; }
      run(commit(f.message.value.trim(), direct ? '' : nb));
    }
  };

  document.addEventListener('click', e => {
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
    if (k === 'statusF') { S.statusF = e.target.value; render(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; render(); } });
  document.addEventListener('mouseover', e => { if (S.view === 'trace') highlight(e.target.closest('[data-node]')?.dataset.node || null); });
  document.addEventListener('focusin', e => { if (S.view === 'trace' && e.target.dataset?.node) highlight(e.target.dataset.node); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sel) actions.close(); });
  window.addEventListener('resize', () => { if (S.view === 'trace') drawTrace(); });

  /* ---------------- boot ---------------- */
  S.token = loadToken();
  const cfg = ls.get('se.cfg', {});
  const params = new URLSearchParams(location.search);
  const repo = params.get('repo') || cfg.repo;
  if (repo && (S.token || params.get('repo'))) run(connect(repo, params.get('root') || cfg.root, params.get('branch') || cfg.branch));
  else render();
})();
