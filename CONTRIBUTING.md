# Contributing to dav-mcp

Contributions are welcome. Two rules come first, because pull requests that
break them are closed.

## The two rules

1. **Issue first.** Every pull request must reference an issue that was opened
   *before* the pull request. Open the issue, describe the problem or the
   change, then send the PR with `Closes #<number>` in its description. Pull
   requests without a prior issue are closed.
2. **No AI spam.** Using AI tools is fine. But you must understand every line
   you submit and be able to explain it. Pull requests that their author cannot
   explain, or that look like unreviewed generated output, are closed without
   discussion.

## Setup

dav-mcp needs Node.js 18 or newer. CI tests on 18, 20 and 22; the container
image runs on Node 22.

```bash
git clone https://github.com/PhilflowIO/dav-mcp.git
cd dav-mcp
npm install
cp .env.example .env   # fill in your CalDAV/CardDAV server
```

Run the server locally with `npm run dev` (stdio) or `npm run dev:http` (HTTP).

dav-mcp uses two packages of its own from npm: the tsdav fork
(`PhilflowIO/tsdav`, published as `@philflow/tsdav`) and `PhilflowIO/tsdav-utils`
(published as `@philflow/tsdav-utils`). `package.json` installs them under npm
aliases at exact versions, so the code imports `tsdav` and `tsdav-utils`:

```json
"tsdav": "npm:@philflow/tsdav@2.4.0",
"tsdav-utils": "npm:@philflow/tsdav-utils@0.4.1"
```

Both repositories publish a release to npm when a release tag is pushed. Never
depend on a git URL or a tarball URL: npm 12 refuses both by default, and the
`npm-12` CI job fails on them. To move to a newer release:

```bash
TSDAV_VERSION=2.4.0 npm run update:tsdav
TSDAV_UTILS_VERSION=0.4.1 npm run update:tsdav-utils
```

## Tests

```bash
npm test
```

Runs the Jest unit tests in `__tests__/`. They need no DAV server and must pass
on every pull request. A bug fix comes with a test that fails without the fix.

`npm run test:integration` runs the end-to-end suite in `tests/integration/`.
It measures whether an LLM picks the right tool with the right parameters, so it
needs more than a DAV server:

- a CalDAV/CardDAV server, configured via `CALDAV_SERVER_URL`,
  `CALDAV_USERNAME` and `CALDAV_PASSWORD`, and seeded with
  `npm run test:setup-data`
- a running dav-mcp server logging to `/tmp/mcp-server.log`
- an n8n workflow that sends prompts to an LLM connected to that server,
  reachable at `WEBHOOK_URL`

You do not need to run the integration suite for every change. Run it when you
change tool names, tool descriptions or parameter schemas, because those are
what the LLM sees.

If you touch the `Dockerfile`, build the image and check that it boots and
reports healthy. The server exits at startup when it cannot reach a CalDAV
server, so a bare `docker run` proves nothing. Either run
`docker compose up --build`, which uses the server from your `.env`, or start a
throwaway Radicale the way CI does (`.github/workflows/docker.yml`):

```bash
docker build -t dav-mcp:dev .
docker network create davdev
docker run -d --name radicale --network davdev tomsquest/docker-radicale:latest
docker run -d --name dav-mcp --network davdev \
  -e CALDAV_SERVER_URL=http://radicale:5232 \
  -e CALDAV_USERNAME=dev -e CALDAV_PASSWORD=dev \
  dav-mcp:dev
docker inspect -f '{{.State.Health.Status}}' dav-mcp   # "healthy" within a minute
```

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): subject`, for example `fix(caldav): keep all-day events in UTC`.
- One commit, one reason. If the subject needs an "and", split the commit.
- The commit body explains *why*, not *what*. The diff already shows what.

## Pull requests

- Keep them focused: one problem per pull request. Unrelated cleanups go into
  their own issue and pull request.
- Fill in the pull request template, including the `Closes #` line.
- CI must be green.

## Releases

Releases are published from CI by `.github/workflows/release.yml`, never from
a local checkout. Pushing a tag `v<version>` on a commit of `main` packs the
package once, installs and starts that tarball on Node 18 to 26 (Node 26 with
npm 12, which refuses git and tarball-URL dependencies), publishes it to npm
with a provenance attestation, creates the GitHub release from the CHANGELOG,
and then builds the MCP Bundle, the MCP Registry entry and the container image
from the same tag. npm authenticates the publish job through trusted
publishing (GitHub OIDC); there is no npm token, and the job runs in the
`npm-publish` environment, which needs a maintainer's approval.

The version lives in `package.json`; four other files repeat it.

1. In a release pull request, set the new version in `package.json` and
   `server.json` (top level and the npm package entry), run
   `npm run mcpb:sync` (writes it into `manifest.json`), and turn
   `## [Unreleased]` in `CHANGELOG.md` into `## [<version>] - <date>`; that
   section becomes the release notes. Do **not** run `npm run plugin:sync`
   yet: the Claude directory follows `main` and the plugin there starts
   `npx -y dav-mcp@<version>`, so it may only point at a version that is
   already on npm. CI (`plugin-pin` in `test.yml`) fails while it doesn't.
2. Merge the pull request, then tag the merge commit on `main` and push the
   tag:

   ```bash
   git fetch origin
   git tag v<version> origin/main
   git push origin v<version>
   ```

   The workflow refuses a tag that differs from the version in `package.json`,
   `server.json` or `manifest.json`, a commit that is not on `main`, a version
   with `+build` metadata, and a version without a CHANGELOG section. A
   prerelease (`-rc.1`) goes to the npm dist-tag `next` and does not move the
   image's `latest`.
3. Approve the `npm-publish` deployment when the run asks for it.
4. Once the run is green, pin the Claude plugin to the new version in a
   pull request: `npm run plugin:sync`, commit `claude-plugin/`.

A failed run is re-run with "Re-run failed jobs", which keeps the tarball that
was already packed. A version that is on npm is never replaced. The bundle,
registry and image workflows can also be started by hand for an existing
release tag (Actions, "Run workflow").

## Security issues

Do not open a public issue for a vulnerability. Report it privately via
[GitHub private vulnerability reporting](https://github.com/PhilflowIO/dav-mcp/security/advisories/new).
