# robomp

A self-hosted GitHub triage-and-fix bot that drives [`omp --mode rpc`](https://github.com/can1357/oh-my-pi).
For every issue opened on an allowlisted repository, robomp:

1. **Triages** — reads the issue, classifies it (`bug` / `question` / `enhancement` / …) and applies labels via the GitHub API.
2. **Branches on the classification:**
   - `bug` / `documentation` → reproduce in an isolated workspace, fix on a fresh branch, open a PR with a four-section body (`Repro / Cause / Fix / Verification`) that closes the issue.
   - `question` → answer in one comment, no PR.
   - `enhancement` / `proposal` → one thoughtful comment, no PR.
   - `invalid` / `duplicate` → one brief comment, no PR.
3. **Keeps the conversation going** — follow-up comments and PR review comments resume the same omp session so the agent retains its prior reasoning and tool history.
4. **Cleans up** on issue close / PR merge.

The orchestrator runs in Docker on a single developer machine alongside a sibling **gh-proxy** container that is the only process holding the GitHub PAT. The orchestrator authenticates to gh-proxy with a shared HMAC key over an internal-only Docker network; it never sees `GITHUB_TOKEN` itself. There is no multi-tenant story; the LLM provider is whatever your local `~/.omp/agent/models.yml` points at.

---

## Status

| Surface | State |
|---|---|
| Webhook receiver (HMAC-verified) | ✅ |
| Per-issue durable event queue (sqlite, dedupe, restart-safe) | ✅ |
| Per-issue git worktrees with credentialed remote | ✅ |
| `classify_issue` + automatic labelling | ✅ |
| Reproduce → fix → PR flow with template enforcement | ✅ |
| Follow-up comment / review-comment session resume | ✅ |
| Workspace cleanup on merge/close | ✅ |
| Identity + working-tree + lint pre-push gates | ✅ |
| Closing-keyword (`Fixes #N`) validation on PR open | ✅ |
| Model pool with per-task random pick | ✅ |
| 80 unit tests (one integration test gated on `ROBOMP_INTEGRATION=1`) | ✅ |
| Production hardening (multi-host, fine-grained PATs, drained restarts) | — out of scope for v1 |

---

## Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │ default network (host-reachable)                     │
                │                                                      │
                │  ┌────────────────────────────────────────────────┐  │
 GitHub ─webhook─▶│ robomp container                                │  │
                │  │   FastAPI (server.py) — HMAC-verify + route()  │  │
                │  │   sqlite events table (durable queue)          │  │
                │  │   WorkerPool — MAX_CONCURRENCY tasks           │  │
                │  │   tasks.{triage_issue, handle_comment, …}      │  │
                │  │   worker.run_task → omp subprocess (bun)       │  │
                │  │     - cwd = per-issue git worktree              │  │
                │  │     - host tools: gh_*, classify_*, repro_      │  │
                │  │   host_tools.py (audited, credential-redacted)  │  │
                │  │   github surface = GitHubProxyClient + Proxy-  │  │
                │  │     GitTransport (HMAC-signed → gh-proxy)      │  │
                │  │   ENV: ROBOMP_GH_PROXY_HMAC_KEY only           │  │
                │  │        (NO GITHUB_TOKEN — refuses to start)    │  │
                │  └──────────────┬─────────────────────────────────┘  │
                │                 │  HMAC-signed HTTP                  │
                └─────────────────┼────────────────────────────────────┘
                                  │
                ┌─────────────────┼────────────────────────────────────┐
                │ robomp_internal network (internal: true — no egress)│
                │                 ▼                                    │
                │  ┌────────────────────────────────────────────────┐  │
                │  │ gh-proxy container (python -m robomp.proxy)   │  │
                │  │   FastAPI on :8081 (no host port mapping)     │  │
                │  │   verifies HMAC → injects PAT into REST calls │  │
                │  │   drives `git push` via --config-env auth     │  │
                │  │   ENV: GITHUB_TOKEN + ROBOMP_GH_PROXY_HMAC_KEY │  │
                │  └────────────────────────────────────────────────┘  │
                └──────────────────────────────────────────────────────┘
   Mounts (host → container, read-only unless noted):
     /work/pi                       → /work/pi              (orchestrator only)
     ~/.omp/agent/models.yml        → /root/.omp/agent/models.yml (orchestrator only)
     ./data                         → /data                 (rw — shared by both containers)
   extra_hosts (orchestrator only):
     llm-gateway.internal:host-gateway  (so models.yml URLs reach the host proxy)
```

Two containers form the trust boundary: the **orchestrator** runs FastAPI + the omp subprocess + host tools, while the **gh-proxy** sibling is the only process that holds `GITHUB_TOKEN` and the only one that talks to api.github.com. Per-issue git worktrees under `/data/workspaces/<owner>__<repo>__<n>/repo/` (shared between both containers via the `./data` bind mount) give per-task filesystem isolation. There is no docker-in-docker.

---

## End-to-end flow

Numbered concretely so you can grep logs for each step.

1. **`POST /webhook/github`** — body HMAC-verified against `GITHUB_WEBHOOK_SECRET`; bad sig returns `401` (GitHub stops retrying).
2. **Route** (`github_events.route`) — decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `cleanup_workspace`, or `skip`. Bot-authored events (`user.login == bot_login`, `*[bot]`, `user.type == "Bot"`) are skipped. PR-derived events resolve to the originating issue's serialization key so two events for the same issue can't run concurrently.
3. **Persist + enqueue** — sqlite `events` row, `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedupes redeliveries). Endpoint returns `202`.
4. **Dispatcher** — `WorkerPool._dispatch_loop` claims the next queued row atomically (`BEGIN IMMEDIATE; SELECT … WHERE state='queued'; UPDATE … 'running'; COMMIT`), guarded by an in-process `_inflight` set keyed by the originating issue. Concurrency capped by `ROBOMP_MAX_CONCURRENCY`.
5. **Workspace** — `sandbox.ensure_workspace`:
   - Idempotent shared clone (`--filter=blob:none`) under `/data/workspaces/_pool/<owner>__<repo>`.
   - Worktree at `/data/workspaces/<owner>__<repo>__<n>/repo` on a deterministic branch `farm/<8hex>/<slug>` derived from `(repo, number)`.
   - `git remote set-url origin` always re-set with the plain HTTPS clone URL. In **gh-proxy mode** the URL is credential-free (the proxy injects auth per push via `git -c http.extraheader`); in **PAT mode** the worker rewrites it to a `https://x-access-token:$PAT@…` form that rotates with the configured PAT.
   - `git config user.email/user.name` set to the configured identity.
6. **omp subprocess** — `RpcClient(omp --mode rpc, cwd=worktree, session_dir=…, no_session=False)` so follow-ups resume the same conversation/tool history. When `<session_dir>/*.jsonl` already exists (follow-up event or crash-restarted task) the worker passes `--continue` so the agent re-enters its prior reasoning, todos, and tool history from the JSONL transcript. Model is randomly picked from `ROBOMP_MODEL` (CSV pool).
7. **Agent (Claude / GPT / …)** drives the work via:
   - **Built-in omp tools** — `read`, `edit`, `write`, `bash`, `lsp`, etc. — operate on the worktree only.
   - **Host tools** — the only surface that mutates GitHub or persists audit rows. See below.
8. **Done** — event marked `done`; on exception, marked `failed` with a credential-redacted traceback in `events.last_error`. Per-issue inflight slot released.

---

## Host tools (the agent's GitHub surface)

| Tool | Purpose | Notes |
|---|---|---|
| `classify_issue` | First action on every new issue. Apply primary + optional priority/functional/provider/platform labels in one call; persist the primary type in sqlite. | Validates: bug ⇒ requires priority; non-bug ⇒ priority forbidden; provider must start with `provider:`; rejects unknown primaries. |
| `set_issue_labels` | Append labels later (e.g. add `wontfix`). Never removes existing. | Used for one-off adjustments outside the initial classify call. |
| `gh_post_comment` | Comment on the originating issue or any specified PR/issue number. | All `gh_*` errors propagate as `RpcCommandError` the agent can recover from. |
| `repro_record` | Persist a reproduction transcript (command, output, exit code, reproduced flag) under `context/repro/`. | Required before claiming a fix; PR template references the path. |
| `gh_push_branch` | `git push --set-upstream origin <branch>` from the worktree. | Refuses to push when (a) working tree dirty, (b) any commit's author ≠ configured identity. Runs `bun run fix` then `bun check` when the repo defines those scripts: any formatter diff is auto-committed as `style: bun run fix` against the configured bot identity; a `bun check` failure raises a recoverable tool error so the agent fixes the cause and retries. |
| `gh_open_pr` | Open a PR from the worktree branch. | Validates body has `## Repro`/`## Cause`/`## Fix`/`## Verification` headers AND `Fixes #N` (or `Closes`/`Resolves`) so GitHub auto-closes the issue on merge. Runs the same `bun run fix` then `bun check` gate as `gh_push_branch` (see above) before the (idempotent) push and PR open. Writes `pr.json` artifact + updates `issues.pr_number/state` in sqlite. |
| `gh_request_review` | Add reviewers / assignees. | Optional. |
| `mark_unable_to_reproduce` | Close the loop without a PR. Posts a structured "Could not reproduce" comment with diagnosis + info request and marks issue `abandoned`. | Use when reproduction genuinely fails after a real attempt. |
| `fetch_issue_thread` | Refetch the issue + comments from GitHub mid-task. | For long-running tasks that want fresh context. |

Every host-tool invocation is audited into the `tool_calls` table with timestamps, args, results, and error messages. Tokens never appear in any audited field — `host_tools._audit` only records the agent-supplied args, and credentialed-URL fragments are stripped at the source by `sandbox.redact_credentials` before any `GitCommandError` / `GitHubError` is raised.

---

## Workflow branches (set by classification)

```
                      classify_issue → primary
                              │
       ┌──────────────────────┼─────────────────────┐
       ▼                      ▼                     ▼
  bug | documentation    question         enhancement | proposal
       │                      │                     │
       ▼                      ▼                     ▼
  ack comment            answer in one         restate + feasibility
  repro_record           gh_post_comment       in one gh_post_comment
  diagnose               (no PR, no branch)    (no PR; wait for opt-in)
  commit (Fixes #N)
  gh_push_branch  ← runs `bun run fix` + `bun check`
  gh_open_pr      ← same gate, then opens the PR
  link comment
```

`invalid` / `duplicate` get one brief explanatory comment and nothing else.

All persona rules live in `src/robomp/prompts/system_append.md` and are appended to omp's own system prompt at session start, so they govern every turn.

---

## Setup

### Prerequisites

- Docker + Docker Compose v2.
- A checkout of `oh-my-pi` (`$PI_ROOT`, default `/work/pi`).
- A LiteLLM-or-equivalent proxy on the host that your `~/.omp/agent/models.yml` already points at (default expectation: `http://llm-gateway.internal:4000`).
- A GitHub account for the bot, with **Write** access on every repo in `ROBOMP_REPO_ALLOWLIST`. Generate a fine-grained PAT scoped to those repos with:
  - Contents: Read+Write
  - Pull requests: Read+Write
  - Issues: Read+Write
  - Metadata: Read

> A classic `repo`-scoped PAT works too but is strictly broader than needed.

### One-time

```bash
cp .env.example .env
$EDITOR .env                       # fill in the GitHub fields + commit identity
openssl rand -hex 32                # → ROBOMP_GH_PROXY_HMAC_KEY (shared by both containers)
openssl rand -hex 32                # → GITHUB_WEBHOOK_SECRET (paste into .env *and* GitHub later)

bun run pi-artifacts               # build oh-my-pi/artifacts:dev (natives + omp-rpc wheel)
bun run build                      # pi-artifacts + docker compose build
bun run up                         # docker compose up -d
curl -fsS http://localhost:8080/healthz   # { "status": "ok" }
```

> The bundled `docker-compose.yml` runs in **gh-proxy mode** by default:
> `GITHUB_TOKEN` is interpolated into the gh-proxy container only, and the
> orchestrator authenticates to it with `ROBOMP_GH_PROXY_HMAC_KEY` over an
> internal-only Docker network. If you instead want to run the orchestrator
> directly (no sidecar, PAT lives in-process) — useful for `python -m robomp.cli`
> on the host or for tests — comment out `ROBOMP_GH_PROXY_URL` /
> `ROBOMP_GH_PROXY_HMAC_KEY` in `.env` and uncomment `GITHUB_TOKEN` in the
> PAT-mode section. The two modes are mutually exclusive (`_validate_proxy_or_pat`
> in `config.py` rejects a `.env` that sets both).

The build is split across two Dockerfiles:

- **`/work/pi/Dockerfile`** — produces the `oh-my-pi/artifacts:dev` image with `/out/pi_natives.linux-<arch>.node` (compiled from `crates/pi-natives`) and `/out/omp_rpc-*.whl`. `bun run pi-artifacts` builds it.
- **`./Dockerfile`** (this repo) — slim runtime that copies those two artifacts from `oh-my-pi/artifacts:dev`, installs robomp's Python deps, and ships an `omp` shim that runs `bun $PI_ROOT/packages/coding-agent/src/cli.ts` against the live pi mount.

Build invalidation is now bounded by intent: editing robomp Python code touches only the runtime layers, never the natives image. Editing pi source rebuilds the natives image, then robomp's `FROM oh-my-pi/artifacts:dev` consumes it.

### Cloudflare tunnel (recommended)

robomp does not ship a tunnel. For a stable hostname:

```bash
brew install cloudflared
cloudflared tunnel login                          # authorize your zone in the browser
cloudflared tunnel create robomp                  # creates ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns robomp robomp.yourdomain.com

cat > ~/.cloudflared/robomp.yml <<EOF
tunnel: <uuid>
credentials-file: $HOME/.cloudflared/<uuid>.json

ingress:
  - hostname: robomp.yourdomain.com
    path: ^/webhook/github\$
    service: http://localhost:8080
  - service: http_status:404
EOF

# foreground (logs to stdout):
cloudflared tunnel --config ~/.cloudflared/robomp.yml run robomp

# or install as a launchd / systemd service for auto-start:
sudo cloudflared --config ~/.cloudflared/robomp.yml service install
```

Note the `path: ^/webhook/github$` constraint — `/healthz`, `/events`, `/issues`, `/replay` stay localhost-only.

If you don't have a Cloudflare zone, `smee.io` and `ngrok http 8080` work fine too — point GitHub's *Payload URL* at whatever public URL your tunnel gives you and use `/webhook/github` as the path.

### GitHub webhook config

In the target repo's *Settings → Webhooks → Add webhook*:

| Field | Value |
|---|---|
| Payload URL | `https://robomp.yourdomain.com/webhook/github` (or your tunnel) |
| Content type | `application/json` |
| Secret | matches `GITHUB_WEBHOOK_SECRET` in `.env` |
| SSL verification | enabled |
| Events | Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments |
| Active | ✓ |

GitHub fires a `ping` on save; you should see `POST /webhook/github 202` in `docker compose logs robomp` within a second.

---

## Configuration reference

All variables are read from `.env`. Compose uses per-service explicit `environment:` allowlists (no `env_file:`), so each variable below only reaches the container(s) that explicitly list it; the `Settings` Pydantic model then validates the result and fails fast on missing required vars.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | yes (gh-proxy only) | PAT for the bot account. Lives ONLY in the gh-proxy container. The orchestrator container refuses to start if `GITHUB_TOKEN` is set in its env. |
| `ROBOMP_GH_PROXY_HMAC_KEY` | yes (both) | Shared HMAC secret the orchestrator uses to authenticate every request to gh-proxy (`openssl rand -hex 32`). Both containers MUST read the same value. |
| `ROBOMP_GH_PROXY_URL` | no (default: `http://gh-proxy:8081`) | URL the orchestrator uses to reach gh-proxy over the internal-only docker network. |
| `GITHUB_WEBHOOK_SECRET` | yes | Shared HMAC secret with the GitHub webhook config. |
| `ROBOMP_BOT_LOGIN` | yes | The bot account's login name (e.g. `roboomp`). Used to skip self-comments and as default `git user.name`. |
| `ROBOMP_REPO_ALLOWLIST` | yes | Comma-separated `owner/repo` entries. Case-insensitive. |
| `ROBOMP_GIT_AUTHOR_NAME` | no (default: `ROBOMP_BOT_LOGIN`) | `git config user.name` for bot commits. |
| `ROBOMP_GIT_AUTHOR_EMAIL` | yes | `git config user.email` for bot commits. `gh_push_branch` refuses to push commits authored by anyone else. |
| `ROBOMP_MODEL` | no (default: `p-anthropic/claude-sonnet-4-6`) | Either a single id or a comma-separated **pool**. One is picked uniformly at random per task; the chosen model is logged as `rpc_model_pick`. |
| `ROBOMP_THINKING` | no (default: `high`) | `off` / `low` / `medium` / `high`. Passed to omp as `--thinking`; `off` omits the flag. |
| `ROBOMP_PROVIDER` | no | Force a specific provider id on omp. Normally unset — `ROBOMP_MODEL` carries `<provider>/<model>`. |
| `ROBOMP_MAX_CONCURRENCY` | no (default: `8`) | Async semaphore cap for in-flight tasks. |
| `ROBOMP_TASK_TIMEOUT_SECONDS` | no (default: `2400`) | Timeout passed to one full `prompt_and_wait` agent turn. |
| `ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS` | no (default: `60`) | Extra wall-clock grace after `ROBOMP_TASK_TIMEOUT_SECONDS` before the worker forcibly stops a stuck RPC client. |
| `ROBOMP_REQUEST_TIMEOUT_SECONDS` | no (default: `120`) | Per-RPC-command timeout (e.g. `set_todos`). |
| `ROBOMP_OMP_COMMAND` | no (default: `omp`) | Executable for the agent subprocess. The shipped image installs an `omp` shim. |
| `ROBOMP_WORKSPACE_ROOT` | no (default: `/data/workspaces` in-container) | Per-issue worktree directory. |
| `ROBOMP_SQLITE_PATH` | no (default: `/data/robomp.sqlite`) | Durable state file. |
| `ROBOMP_LOG_DIR` | no (default: `/data/logs`) | JSON-structured rotating logs (`robomp.log.jsonl`). |
| `ROBOMP_BIND_HOST` / `ROBOMP_BIND_PORT` | no | Receiver bind (`0.0.0.0:8080` by default). |
| `ROBOMP_REPLAY_TOKEN` | no | If set, enables `POST /replay` gated on `X-Robomp-Replay-Token`. Empty/whitespace counts as disabled. |

---

## CLI

The container's entrypoint is `python -m robomp serve`. Other subcommands:

```bash
docker compose exec robomp robomp triage  owner/repo#123   # fetch issue live, enqueue it, and wait for completion
docker compose exec robomp robomp status                   # tabular dump of the issues table
docker compose exec robomp robomp replay  <delivery_id>    # re-enqueue a stored event and wait for completion
docker compose exec robomp robomp cleanup owner/repo#123   # force workspace removal + state=abandoned
```

`triage` constructs a synthetic `issues.opened` payload from the live issue and queues it for the running `serve` dispatcher. Both `triage` and `replay` wait for a terminal event state, bounded by `--wait-timeout` (default: task timeout + hard grace + 30 seconds).

---

## Operational notes

- **No PR without a recorded repro.** The persona prompt requires `repro_record` before any code change; if reproduction genuinely fails, `mark_unable_to_reproduce` closes the loop politely.
- **One PR per issue.** Follow-up comments and reviews push commits to the same `farm/<hex>/<slug>` branch; the same PR receives all amendments.
- **Session persistence.** Each issue has its own `.omp-session/` directory under the workspace, mounted via `/data` so it survives container restarts. Follow-ups resume the prior conversation without re-reading the issue.
- **Crash recovery.** The sqlite `events` queue persists every verified webhook before the receiver returns `202`. On next start, `db.reset_stuck_running()` flips any `running` row back to `queued`; the dispatcher then re-runs that task, and because `<session_dir>/*.jsonl` already exists the worker passes `--continue` so the agent re-enters its prior reasoning, todos, and tool history from the JSONL transcript instead of restarting from scratch. Cleanly-drained shutdown is bounded by `ROBOMP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS` (default 25s) plus `ROBOMP_SHUTDOWN_KILL_TIMEOUT_SECONDS` (default 5s); `stop_grace_period: 30s` in `docker-compose.yml` covers both. Side-effect idempotency (e.g. don't double-post the same `gh_post_comment` — detect prior posts via `fetch_issue_thread`) remains the agent's responsibility; the residual write-then-crash race is documented as out-of-scope follow-up.
- **Logs.** All output is structured JSON (`{"ts","level","logger","msg",…}`) on stdout and rotated into `/data/logs/robomp.log.jsonl`. Useful filters:
  ```bash
  docker compose logs -f robomp | grep -v issues.labeled
  docker compose exec robomp python -c "
  import sqlite3; c = sqlite3.connect('/data/robomp.sqlite'); c.row_factory = sqlite3.Row
  for r in c.execute(\"SELECT ts, tool, error FROM tool_calls WHERE issue_key=? ORDER BY id\", ('owner/repo#123',)):
      print(r['ts'], r['tool'], r['error'] or 'ok')"
  ```
- **Inspection endpoints (localhost-only via the tunnel ingress rule):**
  - `GET /events?limit=50` — recent webhook deliveries with state.
  - `GET /issues?limit=100` — current per-issue state + classification.
  - `GET /healthz` / `GET /readyz` — trivial.

---

## Verification

```bash
# Unit tests (fast — no network, no GitHub, no omp subprocess).
pytest -x tests/                              # 80 tests, ~2s

# Gated integration: a real `omp --mode rpc` subprocess against a fake GitHub
# (httpx.MockTransport) and a local bare git repo. Requires omp on PATH.
ROBOMP_INTEGRATION=1 pytest -x tests/test_worker_smoke.py

# Live container.
bun run build && bun run up
curl -fsS http://localhost:8080/healthz       # {"status":"ok"}

# Live end-to-end against a real (or test) issue:
docker compose exec robomp robomp triage owner/repo#1
docker compose logs -f robomp                 # in another shell, watch each tool call
```

---

## Security posture (v1)

### Credential isolation

- **`GITHUB_TOKEN` lives only in the gh-proxy container.** `docker-compose.yml` interpolates `${GITHUB_TOKEN}` from `.env` into gh-proxy's explicit `environment:` allowlist and nowhere else (the orchestrator's allowlist deliberately omits it). The orchestrator's startup explicitly refuses to boot if it observes `GITHUB_TOKEN` in its own environment (`_require_proxy_mode` in `cli.py` / `server.py`), so a misconfigured deployment fails loudly instead of leaking the PAT into the agent subprocess.
- **Orchestrator holds only the HMAC key.** `ROBOMP_GH_PROXY_HMAC_KEY` is the sole credential the orchestrator carries. It signs every proxy request (`proxy_hmac.sign`) with a timestamp + HMAC-SHA256 over the canonical request; gh-proxy verifies with a ±30s skew window and constant-time compare.
- **Agent subprocess gets neither.** `worker._SCRUBBED_ENV_KEYS` strips `GITHUB_TOKEN`, `ROBOMP_GH_PROXY_HMAC_KEY`, and friends out of the env passed to the omp subprocess; the agent's host tools authenticate to gh-proxy through the orchestrator's in-process `GitHubProxyClient`, never by reading env vars.
- **`git push` uses `--config-env` PAT injection inside gh-proxy.** The proxy never writes the PAT to disk or to a credentialed remote URL. It invokes `git -c http.extraheader=AUTHORIZATION:basic\ <base64-via-env> push …` so the token is passed through a process env var that lives only for the duration of the push; the remote URL stays token-free in `.git/config`.
- **Network isolation.** gh-proxy has **no host port mapping** and `robomp_internal` (the orchestrator↔gh-proxy network) is `internal: true` — no ingress from outside the compose project, no egress through that network. gh-proxy DOES join the `default` network for the single purpose of egress to `api.github.com`; this is unavoidable for it to reach GitHub. The orchestrator joins both networks (default for webhook ingress + the host LLM gateway, `robomp_internal` to reach gh-proxy).

### Request hygiene

- **Webhook signature** is verified with constant-time HMAC-SHA256; bad signatures return `401` (not `5xx`) so GitHub stops retrying spam.
- **Allowlist**. `route()` skips any event whose `repository.full_name` isn't in `ROBOMP_REPO_ALLOWLIST` (case-insensitive). No state mutation, no audit row beyond `state=skipped`.
- **Bot self-comments + bot-authored review comments** are filtered out at routing time (by `login == bot_login`, `*[bot]` suffix, or `user.type == "Bot"`).
- **Token never enters audited data.** `git` subprocess errors flow through `git_ops.GitCommandError` which redacts `https://user:password@host` → `https://***@host` from argv, stdout, and stderr before raising. `host_tools._audit` only records the agent's tool arguments and structured results, never the credentialed clone URL.
- **Pre-push gates** in `gh_push_branch`:
  1. branch must match the workspace branch (no opportunistic pushing to arbitrary refs),
  2. working tree must be clean,
  3. every commit between `origin/<default-branch>..HEAD` must carry the configured `ROBOMP_GIT_AUTHOR_NAME` + `ROBOMP_GIT_AUTHOR_EMAIL`.
- **Pre-PR gates** in `gh_open_pr`: when the repository defines them, `bun run fix` runs first (any resulting diff is auto-committed as `style: bun run fix` with the configured bot identity) and `bun check` runs second. A failing `bun check` is returned to the agent as `RpcCommandError` so it can iterate at the source and retry. Both gates short-circuit before the PR is pushed/created.
- **`/webhook/github` is the only public path.** The recommended Cloudflare ingress config restricts the tunnel hostname to that exact path; admin/inspection routes are localhost-only.
- **LLM credentials never enter either container.** The host's LiteLLM proxy is reached via `extra_hosts: ["llm-gateway.internal:host-gateway"]` from the orchestrator only; the only thing mounted in is `~/.omp/agent/models.yml` (whose `apiKey` fields are stub characters — real auth happens at the gateway).

---

## Repo layout

```
robomp/
├── Dockerfile                  # slim runtime; consumes oh-my-pi/artifacts:dev
├── docker-compose.yml          # mounts, extra_hosts, per-service env allowlists
├── package.json                 # `bun run pi-artifacts`, `bun run build`, `bun run up`, …
├── entrypoint.sh
├── pyproject.toml
├── README.md
├── .env.example
├── src/robomp/
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py                  # `robomp serve|triage|replay|status|cleanup`
│   ├── config.py               # Pydantic Settings; model_pool, pick_model, validators
│   ├── db.py                   # sqlite schema + DAO, classification column + migration
│   ├── github_client.py        # httpx wrapper; redirect handling; retry-after parsing
│   ├── github_events.py        # verify_signature + route() dispatch
│   ├── host_tools.py           # 9 host tools (classify_issue first), all audited
│   ├── logging_config.py       # JSON formatter + rotating file
│   ├── persona.py              # mustache-style prompt renderer
│   ├── prompts/
│   │   ├── system_append.md
│   │   ├── kickoff_issue.md
│   │   ├── followup_comment.md
│   │   └── followup_review.md
│   ├── queue.py                # WorkerPool, _dispatch_loop, _claim_next_unique
│   ├── sandbox.py              # clone pool + worktree lifecycle; GitCommandError redactor
│   ├── server.py               # FastAPI app, /webhook/github, /events, /issues, /replay
│   ├── tasks.py                # triage_issue, handle_comment, handle_pr_conversation,
│   │                           # handle_review, cleanup_workspace
│   └── worker.py               # RpcClient driver, todo seeding, model picker
└── tests/                      # 80 passing, 1 skipped (gated integration)
```

---

## Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| `401 invalid signature` on webhook | `GITHUB_WEBHOOK_SECRET` mismatch with the repo webhook config. |
| Container exits immediately with `PI_ROOT … missing` | The host's pi checkout isn't mounted at `/work/pi`. Adjust `volumes:` (or `PI_ROOT=` env when invoking compose). |
| `git push` fails with `Authentication required` | The PAT does not have push access on the repo, or `ROBOMP_BOT_LOGIN` doesn't match the PAT's account. The credentialed remote URL is `https://<bot_login>:<token>@github.com/<owner>/<repo>.git`. |
| `refusing to push: commit author identity mismatch` | Some commit on the branch was authored under a different name/email. Amend with `git commit --amend --reset-author --no-edit`. The error lists every offending sha. |
| `refusing to push: working tree is dirty` | Agent has uncommitted edits. `git add -A && git commit --amend --no-edit --reset-author` and retry — or just call `gh_open_pr`, which folds `bun run fix` output into a `style:` commit automatically. |
| ``refusing to open PR: `bun check` failed before PR creation`` | The deterministic pre-PR `bun check` step failed. Fix the reported failure at the source, commit, and retry `gh_open_pr` (no need to rerun `bun run fix` yourself — the host tool does that too). |
| Agent loops on the same comment | A non-bot reply triggered `handle_comment`; check `/events?limit=20` to see what was queued and `/issues` for the per-issue state. |
| PR opened without the four template sections, or without `Fixes #N` | Shouldn't happen — `gh_open_pr` validates both. If you see it, the agent reached an out-of-process write somehow; inspect `tool_calls`. |
| `omp` fails with `Failed to load pi_natives` | The `pi_natives.linux-<arch>.node` is missing or built for the wrong arch. Rebuild via `bun run pi-artifacts` (then `bun run build` to refresh the runtime image). The natives source lives at `crates/pi-natives/` inside `/work/pi`. |
| Tasks all fail with `No API key found for <provider>` | `~/.omp/agent/models.yml` isn't mounted, or its provider id doesn't match what's in `ROBOMP_MODEL`. Check `docker compose exec robomp ls /root/.omp/agent/`. |

---

## License

MIT.
