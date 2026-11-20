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
| Requirements | `model/requirements/<LEVEL>/` | STK -> USER -> SYS with upward traces |
| Architecture | `model/components/` | Product breakdown and requirement allocation |
| Interfaces | `model/interfaces/` | Interface register and N2 matrix |
| Verification | `model/verification/` | Cases, results and requirement coverage |
| Risks | `model/risks/` | Register and likelihood x impact matrix |
| Decisions | `model/decisions/` | Decision log and affected items |

Trace, Validation, Changes and History cut across all of them.

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

## Requirement file

```json
{
  "id": "SYS-004",
  "title": "Alert latency",
  "text": "The system shall raise an alert within 2 minutes of a reading falling outside its permitted range.",
  "status": "approved",
  "priority": "must",
  "verification": "test",
  "traces": ["USER-003"]
}
```

`traces` points upward to the parent level. Unknown fields are preserved.

## Known limits of the PoC

- Sign-in is a pasted token. A static page cannot complete GitHub's OAuth flow on its
  own (the token exchange needs a secret and is not CORS-enabled); a GitHub App plus a
  very small token-exchange endpoint is the next step.
- New IDs are allocated per branch, so two branches can both create `SYS-011`. The
  merge will conflict on the file, which is visible but not friendly.
- GitHub only. GitLab/Gitea need a second API adapter (`gh()` and the six calls around it).
- Team access is simulated in the browser, not enforced by GitHub.
- No restricted-repo split or Git LFS yet.
