# Releasing @pincast/api

Pushing a tag `v<version>` on main publishes the package to npm, with provenance, through `.github/workflows/publish.yml`. npm trusts that workflow by its file name, so no npm token is stored anywhere.

The first version was the exception. npm can only trust a workflow for a package that already exists, so 0.1.0 was published by hand from the npm account `pincast`.

## Every release

1. Bring in the API file from NYID. The routes live on NYID's main, so its `docs/api/placecard-v1.openapi.json` is the source and this package keeps a byte-for-byte copy. The script finds NYID at `../NYID`, beside this repo, or wherever `NYID_REPO` points.

   ```sh
   npm run sync
   ```

   The script fetches NYID's main first. Set `NO_FETCH=1` to use the main it already has. Its exit code tells you what happened:

   - 0: the copy matches NYID's main.
   - 1: NYID's file was different, and the script has copied it here.
   - 2: NYID or its file couldn't be read.

2. Regenerate the types and run the checks. If the sync changed the file, do this before anything else.

   ```sh
   npm run generate
   npm run check
   npm test
   ```

3. Write the changelog entry. The script reads the commit subjects since the last tag, along with the API file's changes, and suggests a version by the rule in the README's Versions section.

   ```sh
   npm run changelog                       # prints the entry and the version
   npm run changelog -- --write            # adds it to CHANGELOG.md and sets package.json's version
   npm run changelog -- --write --version 0.3.0   # the same, with a version you choose
   ```

   A subject like `feat: ...` goes under Added, `fix: ...` under Fixed and `feat!: ...` under Breaking. Docs, tests, CI and chores stay out. Treat what it writes as a draft, and edit each line until it says what changed for someone using the package.

4. Commit, push main, and wait for CI to pass.

5. Tag that commit and push the tag.

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

   The Publish workflow checks that the tag names package.json's version and that the changelog has an entry for it. Then it runs the tests and the operations check, and publishes. If the version is already on npm, it says so, skips the publish and passes.

## The first publish, by hand

These are the steps for publishing 0.1.0 by hand. The owner of the npm account `pincast` runs them and approves the publish with the account's security key. Before you start, check two things:

- `pincastFM/pincast-api` is public, and its main holds the commit to release.
- Your terminal has Node 22.14.0 or later and npm 11.15.0 or later. npm 11.15.0 is the first with `npm trust`, which the next section uses.

Run these in order. Each npm step that needs the account prints a link: open it, sign in as `pincast`, and approve with the security key.

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

The Publish workflow runs its checks, finds 0.1.0 already on npm, prints that there's nothing to publish, and passes. That is the result you want.

## Trusted publishing, set up on the day of the next release

A new trusted publisher expires if it hasn't published within 2 days, so set it up on the day you tag the next version.

On npmjs.com, signed in as `pincast`, open the package `@pincast/api`, go to Settings, then Trusted publishing, and choose GitHub Actions. Fill in these fields, save, and approve with the security key:

| Field | Value |
|:-|:-|
| Organization or user | `pincastFM` |
| Repository | `pincast-api` |
| Workflow filename | `publish.yml` |
| Environment name | leave it empty |

Or do the same from a terminal, signed in the same way:

```sh
npm trust github @pincast/api --repo pincastFM/pincast-api --file publish.yml --allow-publish
npm trust list @pincast/api
```

Then, within those 2 days, tag the next version (Every release, step 5). The workflow publishes it with provenance, and this shows the provenance record:

```sh
npm view @pincast/api@0.2.0 dist.attestations --registry https://registry.npmjs.org
```

If the 2 days run out first, remove the trusted publisher on the same settings page, add it again, and tag.

## The API file check in CI

CI compares the package's API file with NYID's every day and on every push. NYID is private, so that job needs a repository secret, `NYID_READ_TOKEN`: a fine-grained GitHub token that can read the contents of `pincastFM/NYID` and nothing else. The job checks out NYID beside this repo and runs:

```sh
NO_FETCH=1 node scripts/sync-openapi.mjs --check
```

Without the secret (in a fork, for example), the job reports the check as skipped and passes.
