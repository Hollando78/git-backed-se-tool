/* Strata — static requirements app backed by a GitHub repository.
   No server: the browser talks to api.github.com with the user's own token. */
(() => {
  'use strict';
  const API = 'https://api.github.com';
  const M = window.SEModel;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
  };

  const S = {
    token: '', user: null, owner: '', repo: '', root: 'model', repoInfo: null,
    branches: [], branch: '', head: null, project: M.project(), commits: [],
    base: new Map(),   // id -> { path, sha, data, dir, file }  as committed at head
    bad: [],           // files that failed to parse
    work: new Map(),   // id -> data  (base + staged edits)
    view: 'overview', q: '', statusF: '', sel: null, hist: {}, loading: '', error: '', committing: false
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
      if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') msg = 'GitHub rate limit reached. Sign in with a token for a higher limit.';
      if (r.status === 404 && !S.token) msg = 'Not found. Private repositories need a token.';
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  }
  const R = () => `/repos/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;
  const encRef = b => b.split('/').map(encodeURIComponent).join('/');
  const webUrl = () => `https://github.com/${encodeURIComponent(S.owner)}/${encodeURIComponent(S.repo)}`;
  const canWrite = () => !!(S.token && S.repoInfo && S.repoInfo.permissions && S.repoInfo.permissions.push);

  async function blobText(sha) {
    const key = 'se.blob:' + sha;   // content-addressed, so a cached copy is always valid
    try { const c = sessionStorage.getItem(key); if (c != null) return c; } catch { /* ignore */ }
    const b = await gh(`${R()}/git/blobs/${sha}`);
    const text = new TextDecoder().decode(Uint8Array.from(atob(b.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
    try { sessionStorage.setItem(key, text); } catch { /* ignore */ }
    return text;
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
    await loadBranch(pick);
  }

  async function loadBranch(branch) {
    S.branch = branch; S.loading = 'Reading ' + branch + '…'; S.sel = null; render(); renderDrawer();
    const cfg = ls.get('se.cfg', {}); cfg.branch = branch; ls.set('se.cfg', cfg);
    const ref = await gh(`${R()}/git/ref/heads/${encRef(branch)}`);
    const tree = await gh(`${R()}/git/trees/${ref.object.sha}?recursive=1`);
    S.head = { sha: ref.object.sha, tree: tree.sha };
    const prefix = S.root + '/requirements/';
    const files = tree.tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix) && /^[^/]+\/[^/]+\.json$/.test(e.path.slice(prefix.length)));
    const projEntry = tree.tree.find(e => e.type === 'blob' && e.path === S.root + '/project.json');
    const [projRaw, raws, commits] = await Promise.all([
      projEntry ? blobText(projEntry.sha) : null,
      Promise.all(files.map(f => blobText(f.sha))),
      gh(`${R()}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(S.root)}&per_page=25`).catch(() => [])
    ]);
    let proj = {};
    try { if (projRaw) proj = JSON.parse(projRaw); } catch { toast('project.json is not valid JSON; using defaults.', true); }
    S.project = M.project(proj);
    S.commits = commits; S.hist = {};
    S.base = new Map(); S.bad = [];
    files.forEach((f, i) => {
      const [dir, file] = f.path.slice(prefix.length).split('/');
      const entry = { path: f.path, sha: f.sha, dir, file, data: null };
      try { entry.data = JSON.parse(raws[i]); } catch (e) { entry.parseError = e.message; }
      if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) S.base.set(file.replace(/\.json$/, ''), entry);
      else S.bad.push(entry);
    });
    S.work = new Map([...S.base].map(([id, e]) => [id, clone(e.data)]));
    const draft = ls.get(draftKey(), {});
    for (const id in draft) draft[id] === null ? S.work.delete(id) : S.work.set(id, draft[id]);
    S.loading = '';
    if (!S.project.levels.some(l => 'level:' + l.key === S.view) && !['overview', 'trace', 'validation', 'changes', 'history'].includes(S.view)) S.view = 'overview';
    render();
  }

  function signOut() {
    saveToken('', false); S.token = ''; S.user = null; S.repoInfo = null; S.sel = null;
    render(); renderDrawer();
  }

  /* ---------------- model helpers ---------------- */
  const draftKey = () => `se.draft:${S.owner}/${S.repo}@${S.branch}`;
  const level = key => S.project.levels.find(l => l.key === key);
  const idsOf = key => [...S.work.keys()].filter(id => M.levelOf(id) === key).sort();
  const childrenOf = id => [...S.work].filter(([, d]) => (d.traces || []).includes(id)).map(([cid]) => cid).sort();
  const childLevel = key => S.project.levels.find(l => l.parent === key);

  function changes() {
    const out = [];
    for (const [id, data] of S.work) {
      const b = S.base.get(id);
      if (!b) out.push({ id, type: 'add', path: M.reqPath(S.root, id), data });
      else if (M.serialize(data) !== M.serialize(b.data)) out.push({ id, type: 'mod', path: b.path, data, before: b.data, sha: b.sha });
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
    const entries = [...S.work].map(([id, data]) => {
      const b = S.base.get(id);
      return { file: b ? b.file : id + '.json', dir: b ? b.dir : M.levelOf(id), data };
    }).concat(S.bad.map(b => ({ file: b.file, dir: b.dir, data: null, parseError: b.parseError })));
    return M.validate(S.project, entries);
  }
  function nextId(key) {
    const nums = [...S.work.keys(), ...S.base.keys()].filter(id => M.levelOf(id) === key).map(id => parseInt(id.split('-')[1], 10) || 0);
    return key + '-' + String(Math.max(0, ...nums) + 1).padStart(3, '0');
  }

  /* ---------------- commit ---------------- */
  async function commit(message, newBranch) {
    const ch = changes();
    if (!ch.length) return;
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
          : { path: c.path, mode: '100644', type: 'blob', content: M.serialize(c.data) })
      } });
      const made = await gh(`${R()}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
      let note;
      if (newBranch) {
        await gh(`${R()}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + newBranch, sha: made.sha } });
        const [title, ...rest] = message.split('\n');
        const pr = await gh(`${R()}/pulls`, { method: 'POST', body: { title, body: rest.join('\n').trim(), head: newBranch, base: S.branch } })
          .catch(e => { toast('Branch pushed, but the pull request could not be opened: ' + e.message, true); return null; });
        ls.del(draftKey());
        S.branches.push(newBranch);
        note = pr && /^https:\/\/github\.com\//.test(pr.html_url)
          ? `Opened <a href="${esc(pr.html_url)}" target="_blank" rel="noopener">pull request #${esc(pr.number)}</a> into ${esc(S.branch)}.`
          : `Committed to new branch ${esc(newBranch)}.`;
        S.view = 'overview';
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

  /* ---------------- rendering ---------------- */
  function toast(msg, err) { toastHtml(esc(msg), err); }
  function toastHtml(html, err) {
    const d = document.createElement('div');
    if (err) d.className = 'err';
    d.innerHTML = html;
    $('#toast').append(d);
    setTimeout(() => d.remove(), err ? 9000 : 6000);
  }
  const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
  const statusDot = s => `<span class="dot s-${esc(s)}"></span>`;
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

  function render() {
    const el = $('#shell');
    if (!S.repoInfo) { el.innerHTML = S.loading ? `<div class="loading">${esc(S.loading)}</div>` : connectView(); return; }
    const iss = S.loading ? [] : issues();
    const ch = S.loading ? [] : changes();
    const nav = (view, label, count, key, hot) => `<button data-act="view" data-view="${esc(view)}" class="${S.view === view ? 'on' : ''}">${key ? `<span class="key">${esc(key)}</span>` : ''}${esc(label)}${count != null ? `<span class="count ${hot ? 'hot' : ''}">${count}</span>` : ''}</button>`;
    el.innerHTML = `
      <aside class="sidebar">
        <div class="brand"><span class="brand-icon">S</span><span>STRATA<span class="brand-sub">GIT-BACKED REQUIREMENTS</span></span></div>
        <div class="side-title">${esc(S.project.name)}</div>
        <nav class="nav">
          ${nav('overview', 'Overview')}
          <div class="nav-sep"></div>
          ${S.project.levels.map(l => nav('level:' + l.key, l.name, idsOf(l.key).length, l.key)).join('')}
          <div class="nav-sep"></div>
          ${nav('trace', 'Trace')}
          ${nav('validation', 'Validation', iss.length || null, '', iss.some(i => i.severity === 'error'))}
          ${nav('changes', 'Changes', ch.length || null, '', true)}
          ${nav('history', 'History')}
        </nav>
        <div class="side-bottom">
          <div><label for="branch">Branch</label>
            <select id="branch" data-change="branch">${S.branches.map(b => `<option ${b === S.branch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
          <div class="repo-line"><a href="${webUrl()}" target="_blank" rel="noopener">${esc(S.owner)}/${esc(S.repo)}</a>${S.head ? ` @ ${esc(S.head.sha.slice(0, 7))}` : ''}
            <br><button data-act="reload" style="color:#e9dfc9;text-decoration:underline;font-size:10.5px">Reload from GitHub</button></div>
          <div class="who">${S.user
            ? `${/^https:\/\/avatars\.githubusercontent\.com\//.test(S.user.avatar_url) ? `<img src="${esc(S.user.avatar_url)}" alt="">` : ''}<span>${esc(S.user.login)}</span><button data-act="signout">Sign out</button>`
            : `<span>Read-only (no token)</span><button data-act="signout">Sign in</button>`}</div>
        </div>
      </aside>
      <main class="main">${S.loading ? `<div class="loading">${esc(S.loading)}</div>` : mainView(iss, ch)}</main>`;
    if (S.view === 'trace' && !S.loading) requestAnimationFrame(drawTrace);
  }

  function connectView() {
    const cfg = ls.get('se.cfg', {});
    return `<div class="connect">
      <div class="connect-side">
        <div class="brand"><span class="brand-icon">S</span><span>STRATA<span class="brand-sub">GIT-BACKED REQUIREMENTS</span></span></div>
        <h1>Requirements that live in a git repository.</h1>
        <p>Every requirement is a file. Every change is a commit. Review, sign-off and access control come from the git host you already run.</p>
        <div class="stack"><div>this page · static, no server</div><div>api.github.com · your identity, your permissions</div><div>repository · model/requirements/*.json</div></div>
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

  function mainView(iss, ch) {
    const top = (title, sub, right = '') => `<div class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="spacer"></div>${right}
      ${ch.length && S.view !== 'changes' ? `<button class="btn amber" data-act="view" data-view="changes">Review ${ch.length} change${ch.length > 1 ? 's' : ''}</button>` : ''}</div>`;
    const ro = canWrite() ? '' : `<div class="banner">${S.token ? 'Your account cannot push to this repository, so the model is read-only.' : 'Browsing without a token: the model is read-only.'}</div>`;
    if (S.view === 'overview') return top(S.project.name, esc(S.project.description || '')) + ro + overview(iss, ch);
    if (S.view === 'trace') return top('Trace', 'Hover a requirement to follow its chain up and down the levels.') + traceView(iss);
    if (S.view === 'validation') return top('Validation', 'Schema and trace checks, run in the browser on every edit and in CI on every push.') + validationView(iss);
    if (S.view === 'changes') return top('Changes', `Staged edits on <span class="mono">${esc(S.branch)}</span>, kept in this browser until committed.`) + ro + changesView(ch, iss);
    if (S.view === 'history') return top('History', `Commits touching <span class="mono">${esc(S.root)}/</span> on <span class="mono">${esc(S.branch)}</span>.`) + `<div class="card">${commitList(S.commits) || '<div class="empty">No commits found.</div>'}</div>`;
    const l = level(S.view.slice(6));
    return top(`${l.name} requirements`, l.parent ? `Each traces up to one or more ${esc(l.parent)} requirements.` : 'Top of the hierarchy: what stakeholders need.',
      canWrite() ? `<button class="btn" data-act="new" data-level="${esc(l.key)}">+ New ${esc(l.key)}</button>` : '') + ro + listView(l, iss, ch);
  }

  function overview(iss, ch) {
    const errs = iss.filter(i => i.severity === 'error').length;
    const nonTop = [...S.work].filter(([id, d]) => level(M.levelOf(id))?.parent && d.status !== 'obsolete');
    const traced = nonTop.filter(([, d]) => (d.traces || []).some(t => S.work.has(t))).length;
    const nonLeaf = [...S.work].filter(([id, d]) => childLevel(M.levelOf(id)) && d.status !== 'obsolete');
    const covered = nonLeaf.filter(([id]) => childrenOf(id).some(c => S.work.get(c).status !== 'obsolete')).length;
    const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
    const kpi = (num, lbl, view) => `<button class="card kpi" data-act="view" data-view="${view}" style="text-align:left"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></button>`;
    return `<div class="grid kpis">
        ${kpi(S.work.size, 'requirements', 'level:' + S.project.levels[0].key)}
        ${kpi(pct(traced, nonTop.length), `traced upward (${traced}/${nonTop.length})`, 'trace')}
        ${kpi(pct(covered, nonLeaf.length), `covered below (${covered}/${nonLeaf.length})`, 'trace')}
        ${kpi(errs ? errs : iss.length, errs ? 'validation errors' : 'validation warnings', 'validation')}
      </div>
      <div class="grid two">
        <div class="card"><h3>Levels</h3>
          ${S.project.levels.map(l => {
            const ids = idsOf(l.key);
            return `<div class="lvl-row" data-act="view" data-view="level:${esc(l.key)}"><div class="head"><span class="ref">${esc(l.key)}</span><b>${esc(l.name)}</b><span>${ids.length} requirement${ids.length === 1 ? '' : 's'}</span></div>
              <div class="bar">${S.project.statuses.map(s => { const n = ids.filter(id => S.work.get(id).status === s).length; return n ? `<i class="s-${esc(s)}" style="width:${100 * n / ids.length}%" title="${esc(s)}: ${n}"></i>` : ''; }).join('')}</div></div>`;
          }).join('')}
          <div class="legend">${S.project.statuses.map(s => `<span>${statusDot(s)}${esc(s)}</span>`).join('')}</div>
        </div>
        <div class="card"><h3>Recent commits</h3>${commitList(S.commits.slice(0, 6)) || '<div class="muted">No commits found.</div>'}</div>
      </div>`;
  }

  function commitList(list) {
    return list.map(c => `<div class="commit">
      <a class="sha" href="${esc(/^https:\/\/github\.com\//.test(c.html_url) ? c.html_url : '#')}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a>
      <div class="msg">${esc(c.commit.message.split('\n')[0])}</div>
      <div class="meta">${esc(c.author?.login || c.commit.author?.name || '')} · ${esc(when(c.commit.author?.date))}</div></div>`).join('');
  }

  function listView(l, iss, ch) {
    return `<div class="tools">
        <input id="q" type="search" placeholder="Search ${esc(l.key)} by ID, title or text" value="${esc(S.q)}" aria-label="Search">
        <select data-change="statusF" aria-label="Status filter"><option value="">All statuses</option>${S.project.statuses.map(s => `<option ${S.statusF === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div><div class="reqs" id="rows">${rows(l, iss, ch)}</div>`;
  }
  function rows(l, iss, ch) {
    const q = S.q.trim().toLowerCase();
    const deleted = ch.filter(c => c.type === 'del' && M.levelOf(c.id) === l.key).map(c => c.id);
    const ids = [...idsOf(l.key), ...deleted].sort().filter(id => {
      const d = S.work.get(id) || S.base.get(id).data;
      return (!S.statusF || d.status === S.statusF) && (!q || [id, d.title, d.text].join(' ').toLowerCase().includes(q));
    });
    if (!ids.length) return `<div class="empty">${S.q || S.statusF ? 'Nothing matches the filter.' : `No ${esc(l.key)} requirements yet.`}</div>`;
    const child = childLevel(l.key);
    return ids.map(id => {
      const gone = !S.work.has(id);
      const d = gone ? S.base.get(id).data : S.work.get(id);
      const c = ch.find(x => x.id === id);
      const mine = iss.filter(i => i.id === id);
      const kids = gone ? [] : childrenOf(id);
      return `<button class="req ${c ? 'changed' : ''} ${gone ? 'gone' : ''} ${S.sel?.id === id ? 'sel' : ''}" data-act="open" data-id="${esc(id)}">
        <span class="ref">${esc(id)}</span>
        <span><div class="req-title">${esc(d.title)}</div><div class="req-text">${esc(d.text)}</div></span>
        <span class="req-links">${l.parent ? `↑ ${(d.traces || []).map(esc).join(', ') || '<span style="color:var(--amber)">no parent</span>'}<br>` : ''}${child ? `↓ ${kids.length ? kids.length + ' ' + esc(child.key) : '<span style="color:var(--amber)">not covered</span>'}` : (d.verification ? 'verify: ' + esc(d.verification) : '')}</span>
        <span class="req-side"><span>${statusDot(d.status)}${esc(d.status)}</span><span class="muted">${esc(d.priority)}</span>
          ${c ? chip(c.type, { add: 'new', mod: 'edited', del: 'deleted' }[c.type]) : ''}${mine.length ? chip(mine[0].severity, mine.length + (mine[0].severity === 'error' ? ' error' : ' warning') + (mine.length > 1 ? 's' : '')) : ''}</span>
      </button>`;
    }).join('');
  }

  function traceView(iss) {
    const flagged = new Set(iss.filter(i => ['orphan', 'uncovered', 'trace-dangling', 'trace-level'].includes(i.code)).map(i => i.id));
    return `<div class="trace" id="trace" style="grid-template-columns:repeat(${S.project.levels.length},minmax(0,1fr))"><svg aria-hidden="true"></svg>
      ${S.project.levels.map(l => `<div class="tcol"><h3>${esc(l.key)} · ${esc(l.name)}</h3>
        ${idsOf(l.key).map(id => { const d = S.work.get(id); return `<button class="tnode ${flagged.has(id) ? 'gap' : ''}" data-act="open" data-id="${esc(id)}" data-node="${esc(id)}"><span class="ref">${statusDot(d.status)}${esc(id)}</span>${esc(d.title)}</button>`; }).join('') || '<div class="muted">None</div>'}
      </div>`).join('')}</div>
      <div class="legend"><span><span class="dot" style="background:none;border:1px dashed #e0a93e"></span>trace gap (no parent, or nothing below)</span>${S.project.statuses.map(s => `<span>${statusDot(s)}${esc(s)}</span>`).join('')}</div>`;
  }
  function drawTrace() {
    const box = $('#trace'); if (!box) return;
    const svg = $('svg', box), o = box.getBoundingClientRect();
    const node = id => $(`[data-node="${CSS.escape(id)}"]`, box);
    let html = '';
    for (const [id, d] of S.work) for (const p of d.traces || []) {
      const a = node(p), b = node(id); if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - o.left, y1 = ra.top + ra.height / 2 - o.top, x2 = rb.left - o.left, y2 = rb.top + rb.height / 2 - o.top, mx = (x1 + x2) / 2;
      html += `<path data-from="${esc(p)}" data-to="${esc(id)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
    svg.innerHTML = html;
  }
  function chain(id) {
    const set = new Set([id]);
    const up = x => (S.work.get(x)?.traces || []).forEach(p => { if (!set.has(p)) { set.add(p); up(p); } });
    const down = x => childrenOf(x).forEach(c => { if (!set.has(c)) { set.add(c); down(c); } });
    up(id); down(id);
    return set;
  }
  function highlight(id) {
    const box = $('#trace'); if (!box) return;
    const set = id ? chain(id) : null;
    $$('.tnode', box).forEach(n => { n.classList.toggle('hot', !!set && set.has(n.dataset.node)); n.classList.toggle('dim', !!set && !set.has(n.dataset.node)); });
    $$('path', box).forEach(p => { const on = !!set && set.has(p.dataset.from) && set.has(p.dataset.to); p.classList.toggle('hot', on); p.classList.toggle('dim', !!set && !on); });
  }

  function validationView(iss) {
    if (!iss.length) return `<div class="card empty">No issues. Every requirement passes schema and trace checks.</div>`;
    return `<div class="reqs">${iss.map(i => `<button class="issue" data-act="open" data-id="${esc(i.id)}">${chip(i.severity, i.severity === 'warn' ? 'warning' : 'error')}<span class="ref">${esc(i.id)}</span><span>${esc(i.message)}</span></button>`).join('')}</div>`;
  }

  const FIELDS = ['title', 'text', 'rationale', 'source', 'status', 'priority', 'verification', 'traces'];
  const show = v => Array.isArray(v) ? v.join(', ') : (v ?? '');
  function changesView(ch, iss) {
    if (!ch.length) return `<div class="card empty">No staged changes. Open a requirement, edit it and choose “Stage change”.</div>`;
    const errs = iss.filter(i => i.severity === 'error').length;
    const verb = { add: 'Add', mod: 'Update', del: 'Remove' };
    const msg = ['add', 'mod', 'del'].map(t => { const ids = ch.filter(c => c.type === t).map(c => c.id); return ids.length ? `${verb[t]} ${ids.join(', ')}` : ''; }).filter(Boolean).join('; ');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return `<div class="reqs">${ch.map(c => `<div class="change">
        <div class="change-head">${chip(c.type, { add: 'new', mod: 'edited', del: 'deleted' }[c.type])}<span class="ref">${esc(c.id)}</span><span class="path">${esc(c.path)}</span><button data-act="unstage" data-id="${esc(c.id)}">Discard</button></div>
        <dl class="diff">${FIELDS.map(f => {
          const a = show(c.before?.[f]), b = show(c.data?.[f]);
          if (a === b || (c.type === 'del' && f !== 'title')) return '';
          return `<dt>${f}</dt><dd>${a ? `<del>${esc(a)}</del> ` : ''}${b ? `<ins>${esc(b)}</ins>` : ''}</dd>`;
        }).join('')}</dl></div>`).join('')}</div>
      <form class="card commit-box" data-submit="commit" style="margin-top:16px">
        <h3 style="margin:0">Commit</h3>
        ${errs ? `<div class="banner err" style="margin:0">The model has ${errs} validation error${errs > 1 ? 's' : ''}. You can still commit, but the CI check on the repository will fail.</div>` : ''}
        <label class="field"><span>Message</span><textarea name="message" required>${esc(msg)}</textarea></label>
        <label class="radio"><input type="radio" name="target" value="pr" checked><span>Commit to a new branch and open a pull request into <span class="mono">${esc(S.branch)}</span><br>
          <input name="newBranch" value="se/${esc(S.user?.login || 'edit')}-${stamp}" spellcheck="false" aria-label="New branch name" style="margin-top:6px;width:min(340px,100%);border:1px solid var(--line);border-radius:8px;padding:6px 9px;background:#fff" class="mono"></span></label>
        <label class="radio"><input type="radio" name="target" value="direct"><span>Commit directly to <span class="mono">${esc(S.branch)}</span></span></label>
        <div><button class="btn" type="submit" ${canWrite() && !S.committing ? '' : 'disabled'}>${S.committing ? 'Committing…' : `Commit ${ch.length} file${ch.length > 1 ? 's' : ''}`}</button></div>
      </form>`;
  }

  /* ---------------- drawer ---------------- */
  function openReq(id) {
    if (!S.work.has(id) && !S.base.has(id)) { toast(id + ' is not a requirement file that can be opened here.', true); return; }
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
  function renderDrawer() {
    const el = $('#drawer');
    if (!S.sel || !S.repoInfo) { el.innerHTML = ''; return; }
    const { id, isNew } = S.sel;
    const gone = !isNew && !S.work.has(id);
    const d = isNew ? S.sel.data : (S.work.get(id) || S.base.get(id).data);
    const l = level(M.levelOf(id)) || { key: M.levelOf(id), name: M.levelOf(id), parent: null };
    const b = S.base.get(id);
    const edit = canWrite() && !gone;
    const dis = edit ? '' : 'disabled';
    const changed = isNew || changes().some(c => c.id === id);
    const mine = isNew ? [] : issues().filter(i => i.id === id);
    const kids = isNew || gone ? [] : childrenOf(id);
    const parents = l.parent ? idsOf(l.parent) : [];
    const dangling = (d.traces || []).filter(t => !parents.includes(t));
    const opts = (list, cur, blank) => (blank ? `<option value="">–</option>` : '') + list.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('');
    el.innerHTML = `<div class="scrim" data-act="close"></div>
      <form class="drawer" data-submit="stage" role="dialog" aria-label="Requirement ${esc(id)}">
        <div class="drawer-head"><h2>${esc(id)}</h2><span class="eyebrow">${esc(l.name)}</span>
          ${isNew ? chip('add', 'new') : gone ? chip('del', 'deleted') : changed ? chip('mod', b ? 'edited' : 'new') : ''}
          <button type="button" class="x" data-act="close" aria-label="Close">×</button></div>
        <div class="drawer-body">
          ${mine.map(i => `<div class="mini-issue ${i.severity}">${esc(i.message)}</div>`).join('')}
          <label class="field"><span>Title</span><input name="title" required value="${esc(d.title)}" ${dis}></label>
          <label class="field"><span>Statement</span><textarea name="text" required ${dis}>${esc(d.text)}</textarea></label>
          <label class="field"><span>Rationale</span><textarea name="rationale" style="min-height:60px" ${dis}>${esc(d.rationale)}</textarea></label>
          ${l.parent ? '' : `<label class="field"><span>Source (stakeholder)</span><input name="source" value="${esc(d.source)}" ${dis}></label>`}
          <div class="row3">
            <label class="field"><span>Status</span><select name="status" ${dis}>${opts(S.project.statuses, d.status)}</select></label>
            <label class="field"><span>Priority</span><select name="priority" ${dis}>${opts(S.project.priorities, d.priority)}</select></label>
            <label class="field"><span>Verification</span><select name="verification" ${dis}>${opts(S.project.verification, d.verification, true)}</select></label>
          </div>
          ${l.parent ? `<div class="field"><span>Traces to (${esc(l.parent)})</span><div class="checks">
            ${dangling.map(t => `<label><input type="checkbox" name="traces" value="${esc(t)}" checked ${dis}><span class="ref" style="color:var(--red)">${esc(t)}</span><span>not a valid ${esc(l.parent)} requirement</span></label>`).join('')}
            ${parents.map(p => `<label><input type="checkbox" name="traces" value="${esc(p)}" ${(d.traces || []).includes(p) ? 'checked' : ''} ${dis}><span class="ref">${esc(p)}</span><span>${esc(S.work.get(p).title)}</span></label>`).join('') || '<div class="muted" style="padding:6px 10px">No ' + esc(l.parent) + ' requirements exist yet.</div>'}
          </div></div>` : ''}
          ${childLevel(l.key) && !isNew ? `<div><div class="section-lbl" style="margin-bottom:6px">Traced from (${esc(childLevel(l.key).key)})</div>${kids.map(k => `<button type="button" class="refbtn" data-act="open" data-id="${esc(k)}" title="${esc(S.work.get(k).title)}">${esc(k)}</button>`).join('') || '<span class="muted" style="font-size:12.5px">Nothing traces to this yet.</span>'}</div>` : ''}
          ${b ? `<div><div class="section-lbl" style="margin-bottom:2px">File history</div><div class="mono muted" style="font-size:10.5px;overflow-wrap:anywhere">${esc(b.path)}</div><div id="hist">${S.hist[b.path] ? commitList(S.hist[b.path]) : '<span class="muted" style="font-size:12px">Loading…</span>'}</div></div>` : ''}
        </div>
        <div class="drawer-foot">
          ${edit ? `<button class="btn" type="submit">${isNew ? 'Stage new requirement' : 'Stage change'}</button>` : ''}
          ${!isNew && changed && canWrite() ? `<button type="button" class="btn ghost" data-act="unstage" data-id="${esc(id)}">${gone ? 'Restore' : 'Discard edits'}</button>` : ''}
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
    S.loading = ''; render(); toast(e.message, true);
  });

  const actions = {
    view(t) { S.view = t.dataset.view; S.sel = null; renderDrawer(); render(); window.scrollTo(0, 0); },
    open(t) { openReq(t.dataset.id); },
    close() { S.sel = null; renderDrawer(); $$('.req.sel').forEach(n => n.classList.remove('sel')); },
    new(t) {
      const l = level(t.dataset.level);
      S.sel = { id: nextId(l.key), isNew: true, data: { title: '', text: '', status: S.project.statuses[0], priority: S.project.priorities[0], traces: [] } };
      renderDrawer();
    },
    unstage(t) {
      const id = t.dataset.id, b = S.base.get(id);
      b ? S.work.set(id, clone(b.data)) : S.work.delete(id);
      saveDraft(); if (S.sel?.id === id && !b) S.sel = null;
      render(); renderDrawer();
    },
    delete(t) {
      const id = t.dataset.id, kids = childrenOf(id);
      if (!confirm(`Delete ${id}?` + (kids.length ? `\n\n${kids.join(', ')} trace to it and will be flagged by validation.` : ''))) return;
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
      const data = isNew ? { id } : clone(S.work.get(id));
      data.id = id;
      ['title', 'text', 'rationale', 'source', 'status', 'priority', 'verification'].forEach(k => { if (f[k]) data[k] = f[k].value.trim(); });
      if (level(M.levelOf(id))?.parent) data.traces = $$('[name=traces]:checked', f).map(c => c.value);
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
    if (k === 'statusF') { S.statusF = e.target.value; refreshRows(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; refreshRows(); } });
  function refreshRows() { const el = $('#rows'); if (el) el.innerHTML = rows(level(S.view.slice(6)), issues(), changes()); }
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
