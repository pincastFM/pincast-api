# Releasing @pincast/api

A tag `v<version>` on main publishes the package to npm through `.github/workflows/publish.yml`, with provenance. npm trusts that workflow by its file name, so no npm token is stored anywhere.

The first version is the exception. npm can only trust a workflow for a package that already exists, so 0.1.0 is published by hand.

## Every release

1. Bring in the API file from NYID. NYID's main holds the routes, so its `docs/api/placecard-v1.openapi.json` is the source, and this package keeps a byte copy. The script looks for NYID beside this repo, at `../NYID`, or where `NYID_REPO` says.

   ```sh
   npm run sync
   ```

   Exit 0 means the copy matches NYID's main. Exit 1 means NYID's file was different, and the script has copied it here. Exit 2 means NYID or its file couldn't be read. The script fetches NYID's main first; set `NO_FETCH=1` to use the main it already has.

2. Write the types again and run the checks. After a sync that changed the file, this step comes before anything else.

   ```sh
   npm run generate
   npm run check
   npm test
   ```

3. Write the changelog entry. The script reads the commit subjects since the last tag and the API file's changes, then suggests the version by the rule in the README (Versions).

   ```sh
   npm run changelog                       # prints the entry and the version
   npm run changelog -- --write            # adds it to CHANGELOG.md and sets package.json's version
   npm run changelog -- --write --version 0.3.0   # the same, with a version you choose
   ```

   It reads subjects like `feat: ...` as Added, `fix: ...` as Fixed, and `feat!: ...` as Breaking, and leaves out docs, tests, CI and chores. Edit the entry so each line says what changed for someone using the package.

4. Commit, push main, and wait for CI to pass.

5. Tag that commit and push the tag.

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

   The Publish workflow checks that the tag names package.json's version and that the changelog has an entry for it. It runs the tests and the operations check, then publishes. When the version is on npm already, it says so, skips the publish, and passes.

## The first publish, by hand

The owner of the npm account `pincast` publishes 0.1.0, and approves it with the account's security key. Before you start:

- `pincastFM/pincast-api` is public, and its main holds the commit to release.
- Your terminal has Node 22.14.0 or later and npm 11.15.0 or later. npm 11.15.0 is the first with `npm trust`, which the next section uses.

Run these in order. Each npm step that needs the account prints a link. Open it, sign in as `pincast`, and approve with the security key.

```sh
git clone https://github.com/pincastFM/pincast-api.git
cd pincast-api
node --version                     # v22.14.0 or later
npm --version                      # 11.15.0 or later
npm test
npm run check
npm pack                           # writes pincast-api-0.1.0.tgz and prints its shasum
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org      # pincast
npm publish pincast-api-0.1.0.tgz --access public --registry https://registry.npmjs.org
npm view @pincast/api@0.1.0 version dist.shasum --registry https://registry.npmjs.org
npm logout --registry https://registry.npmjs.org
```

The shasum from `npm view` matches the one `npm pack` printed. npm can take a few minutes to list a new package, so run `npm view` again if it finds nothing.

Then tag 0.1.0 and push the tag:

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

The Publish workflow runs the checks, finds 0.1.0 on npm, prints that there's nothing to publish, and passes. That's the expected result.

## Trusted publishing, set up on the day of the next release

A new trusted publisher expires if it hasn't published within 2 days. So set it up on the day you tag the next version.

On npmjs.com, signed in as `pincast`, open the package `@pincast/api`, then Settings, then Trusted publishing, and choose GitHub Actions. Enter these, save, and approve with the security key:

| Field | Value |
|:-|:-|
| Organization or user | `pincastFM` |
| Repository | `pincast-api` |
| Workflow filename | `publish.yml` |
| Environment name | leave it empty |

The same from a terminal, signed in as above:

```sh
npm trust github @pincast/api --repo pincastFM/pincast-api --file publish.yml --allow-publish
npm trust list @pincast/api
```

Within the 2 days, tag the next version (Every release, step 5). The workflow publishes it with provenance. To see the provenance record:

```sh
npm view @pincast/api@0.2.0 dist.attestations --registry https://registry.npmjs.org
```

If the 2 days pass first, remove the trusted publisher on the same settings page, add it again, and tag.

## The API file check in CI

CI compares the package's API file with NYID's every day and on every push. NYID is private, so that job needs a repository secret, `NYID_READ_TOKEN`: a fine-grained GitHub token that can read the contents of `pincastFM/NYID` and nothing else. The job checks out NYID beside this repo and runs:

```sh
NO_FETCH=1 node scripts/sync-openapi.mjs --check
```

With no secret, as in a fork, the job says the check was skipped and passes.
