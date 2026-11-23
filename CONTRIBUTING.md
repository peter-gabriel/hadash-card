# Contributing

Issues and pull requests are welcome.

## Branching model (git flow)

| Branch | Purpose |
| --- | --- |
| `main` | Released code only. Every merge into `main` is followed by a tagged GitHub release. |
| `develop` | Integration branch. All features land here first. |
| `feature/<name>` | New features and non-urgent fixes. Branch from `develop`, open the PR into `develop`. |
| `release/<version>` | Release preparation (version bump, final fixes). Branch from `develop`, open the PR into `main`, then merge `main` back into `develop`. |
| `hotfix/<version>` | Urgent fixes to a released version. Branch from `main`, open the PR into `main`, then merge `main` back into `develop`. |

Nothing is pushed straight to `main` or `develop`: every change goes through a pull request, and the **Validate** workflow must pass.

## Development

```bash
npm install
npm test          # sky, geometry, area sync and action tests
npm run build     # outputs dist/hadash-card.js
npm run dev       # demo with a fake Home Assistant on http://localhost:5181
npm run ha        # rebuild on change and serve on http://<your-machine-ip>:5182/hadash-card.js
```

To try your build in Home Assistant, add the `npm run ha` URL as a dashboard resource on a test dashboard. Then refresh HA after each change.

The UI is in Brazilian Portuguese for now. Translations (English and Spanish, as in the other cards) are welcome.

The music panel comes from [spotify-panel-card](https://github.com/peter-gabriel/spotify-panel-card) as an npm dependency pinned to a release tag. To work on both at once, point the dependency at a local checkout (`npm i ../spotify-panel-card`) and do not commit that change.

## Releasing

`dist/` is not committed. Every GitHub release gets its own build.

1. Create `release/X.Y.Z` from `develop`.
2. Bump the version without creating a tag: `npm version X.Y.Z --no-git-tag-version`.
3. Open a PR from `release/X.Y.Z` into `main` and merge it once **Validate** passes.
4. Publish a GitHub release with the tag `vX.Y.Z` on `main`. The **Release** workflow then:
   - checks that the tag matches `package.json`;
   - runs the tests and builds the card;
   - attaches `hadash-card.js` to the release, which is the file HACS installs.
5. Merge `main` back into `develop`, through a PR.
