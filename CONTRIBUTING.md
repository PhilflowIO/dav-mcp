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

dav-mcp uses a fork of tsdav (`PhilflowIO/tsdav`), pinned in `package.json` to
the packed tarball of a fork release. A tarball installs without cloning and
building the fork; a git reference makes npm do both, and that build step fails
with the npm that ships with Node 20. To move to a newer fork release, pass the
URL of its `.tgz` release asset:

```bash
TSDAV_TARBALL='https://github.com/PhilflowIO/tsdav/releases/download/v2.3.5%2Bphilflow.5/tsdav-2.3.5-philflow.5.tgz' \
  npm run update:tsdav
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

The version lives in `package.json`; four other files repeat it.

1. Set the new version in `package.json` and `server.json` (top level and the
   npm package entry).
2. Run `npm run mcpb:sync` and `npm run plugin:sync`. They write the version
   into `manifest.json` and `claude-plugin/`; the tests fail until they match.
3. Publish to npm **before** the version bump reaches `main`. The Claude
   directory follows `main` and the plugin there starts
   `npx -y dav-mcp@<version>`, so a version that isn't on npm yet breaks it
   for everyone who has the plugin. CI (`plugin-pin` in `test.yml`) fails
   while the pinned version is missing from npm.
4. Tag `v<version>` and publish the GitHub release; the bundle and registry
   workflows run from it.

## Security issues

Do not open a public issue for a vulnerability. Report it privately via
[GitHub private vulnerability reporting](https://github.com/PhilflowIO/dav-mcp/security/advisories/new).
