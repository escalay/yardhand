# Contributing

Thanks for wanting to make Yardhand better. Bugs, ideas and pull requests are all welcome.

## Before you start

- **Bugs**: open an issue with the bug form. The version and the steps that show it save the most time.
- **Ideas and larger changes**: open an issue first, so we can agree on the shape before you write the code.
- **Security issues**: never in public. See [SECURITY.md](SECURITY.md).

## Making a change

1. Fork and branch from `main` (`feat/…`, `fix/…`).
2. `pnpm install`, then `pnpm demo` for a gateway with fake servers and the app.
3. Write the change with its tests: unit tests next to the rules (`*.rules.test.ts`, `*.test.ts`), API tests in
   `apps/gateway/test`, and a browser test in `apps/web/e2e` when it changes a journey.
4. `pnpm gate` and `pnpm e2e` pass locally.
5. Open a pull request. CI runs the gate, the browser tests, the image through the self-hosting path, a secrets scan
   and CodeQL.

[AGENTS.md](AGENTS.md) is the map of the code: commands, layout, the vocabulary and the rules that hold everywhere.
Coding agents read it too.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:` for something new,
`fix:` for a bug, `docs:`, `refactor:`, `test:`, `chore:`. A breaking change says so with `!` (`feat!:`) and a
`BREAKING CHANGE:` footer explaining what to do.

Releases are automatic. Every merge to `main` updates a release pull request that holds the next version and its
changelog. Merging that pull request tags the release and drafts it; the image is then scanned, run through the
self-hosting path, pushed to `ghcr.io/escalay/yardhand` and signed, the compose file is attached, and only then is
the release published. If that job fails, the release stays a draft: re-run the failed job and it finishes.

A pull request is squashed into one commit named after its title, so the title is the Conventional Commit (CI checks
it). The release pull request is opened by a workflow, and GitHub holds its checks until a maintainer approves the run.

## Style

- TypeScript everywhere, formatted by Biome (`pnpm check:fix`).
- Copy is plain and specific: every error says where, why and what to do next.
- The app only calls `/api`: anything the app can do, an agent can do too.

## License

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of
Yardhand.
