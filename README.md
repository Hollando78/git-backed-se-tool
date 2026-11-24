# Strata — git-backed requirements (proof of concept)

A requirements tool with no database and no server. The model is plain files in a
git repository; a static HTML app reads and writes them through the GitHub API using
the signed-in person's own credentials.

```
Engineers and reviewers  ->  static app (this repo: index.html + app/)
                               UI, in-memory index per commit, validation
                         ->  GitHub (identity, roles, protected branches, CODEOWNERS)
                         ->  repository (model/requirements/<LEVEL>/<ID>.json)
```

## What is here

The landing page is a hub of small apps, each a view over one folder of the model:

| App | Folder | Shows |
| --- | --- | --- |
| Requirements | `model/requirements/<LEVEL>/` | STK -> USR -> REQ with upward traces, plus assumptions |
| Architecture | `model/components/` | Product breakdown (PBS) with zoom levels |
| Interfaces | `model/interfaces/` | Interface register and N2 matrix |
| Verification | `model/verification/` | Cases, results and requirement coverage |
| Risks | `model/risks/` | One risk page per system: map, search, table; issues lit up |
| Decisions | `model/decisions/` | Decision log and affected items |

Trace, Validation, Changes and History cut across all of them.

Requirements and Architecture are spreadsheet-style tables: choose columns, sort,
filter, then **Export CSV** (every attribute of the rows shown) or **Print / PDF**
(the table as shown, landscape, stamped with repository and commit).

Requirements and risks are organised by system. Pick a system (click it in
Architecture, or use the System selector) to see what belongs to it, grouped with the
levels below it (n, n+1, n+2 or all).

| Path | Purpose |
| --- | --- |
| `index.html`, `app/` | The static app. No build step, no dependencies. |
| `app/model.js` | Item schemas, link rules and canonical file format. Shared by the app and CI. |
| `model/project.json` | Project name, requirement levels and allowed field values. |
| `model/team.json` | Simulated people, teams and per-folder access. |
| `tools/validate.js` | Runs the same checks from the command line. |
| `.github/workflows/` | Validation on every push and pull request; Pages deploy. |

## Simulated team

`model/team.json` defines eleven people in seven teams, each with `own`, `write`,
`read` or no access per folder. Pick a person in the hub ("Acting as") and the app
behaves as it would for them: hidden areas disappear (links into them show as
"restricted"), read-only areas cannot be edited, and commits are written with that
person as the git author. GitHub itself still sees only the signed-in account, so this
is a demonstration of the model, not enforcement. Real enforcement maps the same table
onto CODEOWNERS, protected branches and a separate repository for hidden areas.

## Run it

Serve the folder with any static file server and open it:

```bash
python3 -m http.server 8000
```

Then connect to `owner/repo` with a GitHub token. A
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
restricted to the one repository is enough:

- Contents: read and write
- Pull requests: read and write (only for the "open a pull request" option)

To hand the tool to someone without hosting anything, build a single file and send it:

```bash
node tools/build-single.js owner/repo
```

`dist/strata.html` opens straight from disk and works against the repository live.
It contains the app only, no model data and no credentials; each person connects with
their own token, so GitHub decides what they can see and change.

Public repositories can be browsed read-only with no token. `?repo=owner/name&branch=x`
in the URL preselects a repository; on GitHub Pages the repository is inferred from the URL.

## How it works

- **Read:** one call for the branch tip, one for the tree, then one per requirement
  blob (cached by blob SHA). The index is rebuilt in memory for each commit.
- **Edit:** changes are staged in the browser (kept in `localStorage` per branch) and
  shown as a field-level diff.
- **Commit:** all staged files go into a single commit via the Git Data API, either
  onto a new branch with a pull request (default) or directly onto the current branch.
  If the branch moved and someone else changed the same file, the commit is refused.
- **Validate:** required fields, allowed values, ID/file agreement, dangling or
  wrong-level traces (errors); orphans, uncovered parents, missing verification (warnings).

## ID coding and files

Every item ID is `<PROJECT>-<TYPE>-<NNNN>`, for example `HS-REQ-0006`, `HS-ASS-0001`,
`HS-RSK-0005`. `TYPE` is `PBS`, a requirement level (`STK`, `USR`, `REQ`), `ASS`
(assumption), `INT`, `VER`, `RSK` or `DEC`. An ID never changes.

- The system an item belongs to is an attribute (`system`), not part of the ID, so an
  item can be moved to another system without being renumbered.
- Each PBS element carries an ISO 81346 reference designation (RDS-PS / RDS-CW) in its
  `code` attribute: one designation per breakdown level, joined by dots, e.g.
  `A1.BA1.KFA1`. The tool enforces the structure (1, 2 then 3 class letters plus a
  number; a child extends its parent's code; codes are unique). The class-letter tables
  are licensed content: add them to `rds.classes` in `model/project.json` to have the
  letters checked too. The letters in the sample model are illustrative.

```json
{
  "id": "HS-REQ-0004",
  "system": "HS-PBS-0001",
  "object": "requirement",
  "type": "performance",
  "title": "Alert latency",
  "text": "The system shall raise an alert within 2 minutes of a reading falling outside its permitted range.",
  "stability": "stable",
  "status": "approved",
  "compliance": "non-compliant",
  "complianceRationale": "Worst case 3 min 10 s with 40 buoys reporting.",
  "verification": "test",
  "traces": ["HS-USR-0003"],
  "checks": [{ "by": "Hannah Schmidt", "date": "2026-11-21T09:14:00Z", "text": "..." }]
}
```

Rules the validator enforces beyond field types and links:

- An assumption (`ASS`) can never have stability `stable`.
- Compliance evidence must cite a document number and a version (warning if not).
- A risk can only be raised against a PBS system whose control status is `approved`.
- An interface joins two systems at the same level, and may only link requirements that
  belong to one of those two systems.
- Every validation task has an owner: the owner of the item's system, falling back up
  the breakdown to the top-level system owner.

## Checking, validation and baselines

- **Checking** (requirements and architecture): anyone who can see an item can add a
  comment, stamped with their name and the time. Open comments are validation tasks
  until someone closes them, optionally with a close-out note.
- **Validation** lists every task, grouped by owner, with a chart of how many of each
  type each person has. Missing requirement metadata is queued as tasks.
- **Baselines**: every Print / PDF export asks for a minor or major baseline and an
  optional description (CSV exports are plain downloads and are never baselined). The baseline is recorded in `model/exports/register.json` against the
  commit it was taken from. "Baselines" on each page lists them; opening one reloads the
  model at that commit, in the same view, read-only, so the document can be re-exported
  exactly as issued. PDFs carry the document title and baseline version; CSVs start with
  "UNCONTROLLED - INFORMATION ONLY". PDF exports made with uncommitted changes are stamped
  as drafts and not recorded.

## Known limits of the PoC

- Sign-in is a pasted token. A static page cannot complete GitHub's OAuth flow on its
  own (the token exchange needs a secret and is not CORS-enabled); a GitHub App plus a
  very small token-exchange endpoint is the next step.
- New IDs are allocated per branch, so two branches can both coin the same number. The
  merge will conflict on the file, which is visible but not friendly.
- GitHub only. GitLab/Gitea need a second API adapter (`gh()` and the six calls around it).
- Team access is simulated in the browser, not enforced by GitHub.
- The PDF itself is not stored; the register stores what is needed to reproduce it.
- Recording a baseline commits straight to the current branch, so it fails on a protected branch.
- No restricted-repo split or Git LFS yet.
