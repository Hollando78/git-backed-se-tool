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

Every item ID is `<PROJECT>-<SYSTEM>-<TYPE>-<NNNN>`, for example `HS-BUOY-REQ-0006`:

- `SYSTEM` is the code of the PBS element the item belongs to. Each item has exactly one
  home system, fixed when it is created. Interfaces carry `LVL<x>` instead: the breakdown
  level at which their two systems meet.
- `TYPE` is `PBS`, a requirement level (`STK`, `USR`, `REQ`), `ASS` (assumption), `INT`,
  `VER`, `RSK` or `DEC`.

```json
{
  "id": "HS-HSS-REQ-0004",
  "object": "requirement",
  "type": "performance",
  "title": "Alert latency",
  "text": "The system shall raise an alert within 2 minutes of a reading falling outside its permitted range.",
  "stability": "stable",
  "status": "approved",
  "priority": "must",
  "compliance": "non-compliant",
  "complianceRationale": "Worst case 3 min 10 s with 40 buoys reporting.",
  "verification": "test",
  "traces": ["HS-HSS-USR-0003"]
}
```

Rules the validator enforces beyond field types and links:

- An assumption (`ASS`) can never have stability `stable`.
- A risk can only be raised against a PBS system whose control status is `approved`.
- The system code in every ID must exist in the product breakdown.

Stability (stable / developing / unstable) and compliance (compliant / compliance risk /
non-compliant) are shown red-amber-green; the Metrics page rolls them up by requirement
level and by system. Likelihood and impact labels live in `model/project.json` and are
placeholders until the SEMP defines them.

## Known limits of the PoC

- Sign-in is a pasted token. A static page cannot complete GitHub's OAuth flow on its
  own (the token exchange needs a secret and is not CORS-enabled); a GitHub App plus a
  very small token-exchange endpoint is the next step.
- New IDs are allocated per branch, so two branches can both coin the same number. The
  merge will conflict on the file, which is visible but not friendly.
- GitHub only. GitLab/Gitea need a second API adapter (`gh()` and the six calls around it).
- Team access is simulated in the browser, not enforced by GitHub.
- No restricted-repo split or Git LFS yet.
