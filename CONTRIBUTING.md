# Contributing

## Run and test

Node.js 20 or later; nothing to install.

```sh
npm test            # unit tests and the template checks
npm run lint        # whitespace lint of tracked files
npm run check       # the template checks alone, with one line per file
npm start           # run the reference service on port 3000
```

The shell scripts need bash 4.4 or later and GNU coreutils/findutils (any Linux, or the `postgres:16` image).

## Branches

Branch from `main` with a short descriptive name: `fix/hsts-max-age`, `feat/redis-readiness`, `docs/restore-drill`.
Keep a branch to one change; rebase on `main` before opening the pull request.

## Commits

- Imperative subject under 72 characters: "Add readiness probe for Redis", not "Added" or "Adding".
- A body when the reason is not obvious from the diff: what changed and why.
- One logical change per commit; tests in the same commit as the code they cover.

## Changing the templates

Every hardening rule lives in two places: the template that follows it and `scripts/check.mjs`, which enforces it.
When you add a rule, add a fixture in `test/fixtures/` that breaks it and a test that expects the checker to say so.
When you relax a rule, explain the trade-off in the pull request and in the README's hardening section.

## Pull request checklist

- [ ] `npm run lint` and `npm test` pass
- [ ] New checker rules have a failing fixture and a test
- [ ] README or `docs/` updated where behaviour changed
- [ ] `CHANGELOG.md` updated under Unreleased
- [ ] No secrets, real hostnames or customer data
