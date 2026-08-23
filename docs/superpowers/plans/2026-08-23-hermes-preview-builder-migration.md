# Hermes Preview Builder Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the reusable Synqora website builder into a sanitized private repository and install a repaired, isolated, no-delivery instance on the Srikar Hermes VPS.

**Architecture:** Capture the source and non-secret skill bundle without runtime state, repair the approval workflow and test drift in a new `elevate-preview-builder` repository, then install it under a dedicated `elevate-builder` account. The worker may produce a local approved artifact and an unconsumed handoff, but independent code, configuration, credentials, and systemd interlocks prevent GitHub, Vercel, Cloudflare, WhatsApp, or voice side effects.

**Tech Stack:** Python 3.13, SQLite, Pillow 12.3.0, Node.js 22, Playwright 1.61.1, Lighthouse 12.6.1, axe-core 4.12.1, Vite 8.1.4, Chromium, Codex CLI 0.144.1, systemd, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-23-hermes-preview-builder-migration-design.md`

## Global Constraints

- The source `/opt/synqora-builder` and its running services on `Synqora_Srikar` remain unchanged.
- Do not copy source credentials, Codex home, state databases, spools, logs, caches, generated websites, screenshots, deployment receipts, or notification targets.
- Preserve the internal `synqora_builder` Python import namespace during this phase.
- Use repository name `elevate-preview-builder` and service identity `elevate-builder`.
- Use `/opt/elevate-preview-builder`, `/etc/elevate-preview-builder`, `/var/lib/elevate-preview-builder`, `/var/cache/elevate-preview-builder`, `/var/spool/elevate-preview-builder`, `/srv/elevate-preview-builds`, and `/run/elevate-preview-builder`.
- Process exactly one website job at a time with `MemoryMax=2G`, `CPUQuota=150%`, and a 10-minute job deadline.
- `ELEVATE_EXTERNAL_DELIVERY` defaults to `disabled`; deploy and notify commands fail before reading a handoff unless it is exactly `live`.
- Queue, deploy, and notification path units remain disabled after installation and verification.
- Tests and fixtures must not call a real model, create a repository, deploy, message, or call a number.
- Only the final internal smoke test may invoke the model. It must not create an external deployment or notification.
- Use test-driven development for every production behavior change and commit after each task.

## File Map

### Imported and modified

- `src/synqora_builder/model.py` - build request validation and lifecycle.
- `src/synqora_builder/store.py` - durable state and idempotent approval decisions.
- `src/synqora_builder/spool.py` - pending, incoming, running, and archive records.
- `src/synqora_builder/cli.py` - submit, approve, reject, cancel, and status commands.
- `src/synqora_builder/codex.py` - bounded Codex design/build/review runner.
- `src/synqora_builder/skills.py` - deterministic skill selection.
- `src/synqora_builder/worker.py` - one-job pipeline and local handoff.
- `src/synqora_builder/deploy.py` - externally side-effecting publication entry point.
- `src/synqora_builder/notify.py` - externally side-effecting notification entry point.
- `src/synqora_builder/cleanup.py` - bounded artifact and state cleanup.
- `config/design.schema.json` - strict design response schema.
- `config/sol-review.schema.json` - strict final-review response schema.
- `config/skills.json` - repository-owned skill paths.
- `scripts/browser-gate.mjs` - Chromium, Lighthouse, accessibility, overlap, and pixel checks.
- `tests/test_*.py` - repaired unit and integration coverage.

### Created in the new repository

- `README.md` - local and Hermes usage, safety defaults, and recovery.
- `requirements.lock` - exact Python runtime dependency versions.
- `docs/source-provenance.md` - source location, capture time, sanitized digest, and exclusions.
- `docs/migration-baseline.md` - reproducible failing source baseline.
- `docs/hermes-verification.md` - non-sensitive installed-version and verification evidence.
- `skills/*/SKILL.md` - sanitized builder skill bundle.
- `src/synqora_builder/external_delivery.py` - strict delivery mode parser and guard.
- `tests/test_external_delivery.py` - deploy and notification interlock coverage.
- `tests/test_repository_hygiene.py` - prohibited file and credential-pattern checks.
- `tests/test_operational_paths.py` - destination path and reserved-host contract.
- `fixtures/smoke/request.json` - internal, non-lead build request.
- `bin/elevate-preview-builder-{submit,status,cancel,approve,reject,worker,deploy,notify,cleanup}` - operational CLI wrappers.
- `systemd/elevate-preview-builder-{queue.path,worker.service,deploy.path,deploy.service,notify.path,notify.service,cleanup.service,cleanup.timer}` - disabled-by-default service definitions.
- `sysusers/elevate-preview-builder.conf` - dedicated system account.
- `tmpfiles/elevate-preview-builder.conf` - state, spool, cache, workspace, and runtime directories.
- `deploy/install-hermes.sh` - release installation without unit enablement.
- `deploy/verify-hermes.sh` - no-delivery destination verification.
- `deploy/rollback-hermes.sh` - stop, disable, and select the previous release.

---

### Task 1: Capture a Sanitized Source Repository

**Files:**
- Create repository: `/Users/srikarreddy/Downloads/Techstacktree/elevate-preview-builder`
- Import: source files listed in the File Map
- Create: `README.md`
- Create: `docs/source-provenance.md`
- Create: `tests/test_repository_hygiene.py`

**Interfaces:**
- Consumes: read-only SSH aliases `Synqora_Srikar` and `srikarhermes-vps`.
- Produces: a local Git repository whose `HEAD` is the immutable sanitized baseline.

- [ ] **Step 1: Capture the source and skills into a temporary directory**

Run from `/Users/srikarreddy/Downloads/Techstacktree`:

```bash
test ! -e elevate-preview-builder.capture
test ! -e elevate-preview-builder
mkdir -m 700 elevate-preview-builder.capture
rsync -a --delete \
  --exclude '.venv/' --exclude 'node_modules/' --exclude '__pycache__/' \
  --exclude '*.egg-info/' --exclude '._*' --exclude '.git/' \
  Synqora_Srikar:/opt/synqora-builder/ elevate-preview-builder.capture/
mkdir -p elevate-preview-builder.capture/skills
rsync -a --delete --exclude '._*' \
  Synqora_Srikar:/var/lib/synqora-builder/skills/ \
  elevate-preview-builder.capture/skills/
```

Expected: only application source, tests, package metadata, systemd assets, and
skill Markdown files are present. Do not use `scp -r` because it would include
ignored runtimes and AppleDouble files.

- [ ] **Step 2: Write the failing repository-hygiene test**

Create `tests/test_repository_hygiene.py`:

```python
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROHIBITED_NAMES = {".env", "auth.json", "jobs.db", "audit.jsonl", "node_modules", ".venv"}
SECRET_PATTERNS = (
    re.compile(rb"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b"),
)


class RepositoryHygieneTests(unittest.TestCase):
    @staticmethod
    def repository_files():
        if (ROOT / ".git").is_dir():
            output = subprocess.check_output(("git", "ls-files", "-z"), cwd=ROOT)
            return tuple(ROOT / item.decode() for item in output.split(b"\0") if item)
        return tuple(path for path in ROOT.rglob("*") if path.is_file())

    def test_repository_has_no_runtime_or_secret_files(self):
        offenders = []
        for path in self.repository_files():
            if path.name.startswith("._") or path.name in PROHIBITED_NAMES:
                offenders.append(path.relative_to(ROOT).as_posix())
        self.assertEqual([], sorted(offenders))

    def test_bounded_text_files_contain_no_credential_patterns(self):
        offenders = []
        for path in self.repository_files():
            if path.stat().st_size > 1_000_000:
                continue
            data = path.read_bytes()
            if any(pattern.search(data) for pattern in SECRET_PATTERNS):
                offenders.append(path.relative_to(ROOT).as_posix())
        self.assertEqual([], sorted(offenders))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the test and remove any captured violations**

Run:

```bash
cd /Users/srikarreddy/Downloads/Techstacktree/elevate-preview-builder.capture
python3 -m unittest tests.test_repository_hygiene -v
```

Expected: FAIL if the capture contains a prohibited file. Remove only the
reported captured copy, update the rsync exclusion, recapture, and rerun until
PASS. Never delete anything on `Synqora_Srikar`.

- [ ] **Step 4: Record deterministic provenance**

Create `docs/source-provenance.md` with the actual UTC capture time and the
output of this digest command:

```bash
find . -type f -not -path './.git/*' -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  | shasum -a 256
```

The document must name `/opt/synqora-builder`,
`/var/lib/synqora-builder/skills`, `Synqora_Srikar`, the exclusion list, and
the aggregate digest. It must not contain IP addresses or credentials.

- [ ] **Step 5: Initialize the baseline repository and commit**

Run:

```bash
mv elevate-preview-builder.capture elevate-preview-builder
cd elevate-preview-builder
git init -b main
git add .
git commit -m "chore: import sanitized builder baseline"
```

Expected: clean worktree and one local baseline commit. Do not create the
remote repository yet.

### Task 2: Repair the Approval Lifecycle and Queue Reconciliation

**Files:**
- Modify: `src/synqora_builder/model.py`
- Modify: `src/synqora_builder/store.py`
- Modify: `src/synqora_builder/spool.py`
- Modify: `src/synqora_builder/cli.py`
- Modify: `src/synqora_builder/worker.py`
- Modify: `tests/test_model.py`
- Modify: `tests/test_spool_store.py`
- Modify: `tests/test_cli.py`
- Modify: `tests/test_worker.py`
- Create: `docs/migration-baseline.md`

**Interfaces:**
- Consumes: `BuildJob`, `BuildState`, `JobStore`, and `JobSpool` from the baseline.
- Produces: crash-recoverable `submit -> pending_approval -> approve -> queued` behavior.

- [ ] **Step 1: Record the unmodified failing baseline**

Run:

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m unittest discover -s tests -q \
  > /tmp/elevate-builder-baseline.log 2>&1 || true
tail -n 5 /tmp/elevate-builder-baseline.log
```

Create `docs/migration-baseline.md` recording `170 tests`, `31 failures`, `35
errors`, the command, and the categories: stale approval expectations,
descriptor-path assumptions, schema/skill drift, and file-mode drift. Do not
commit the full failure log.

- [ ] **Step 2: Rewrite lifecycle tests to express the approved state machine**

Update `tests/test_model.py`, `tests/test_spool_store.py`, and
`tests/test_cli.py` with assertions equivalent to:

```python
self.assertEqual(BuildState.PENDING_APPROVAL, stored["state"])
self.assertTrue((self.spool / "pending" / f"{job_id}.json").is_file())
self.assertFalse((self.spool / "incoming" / f"{job_id}.json").exists())

approved = self.store.approve_build(job_id)
self.assertEqual(BuildState.QUEUED, approved)
self.spool.release(job_id)
self.assertTrue((self.spool / "incoming" / f"{job_id}.json").is_file())
```

Add tests proving: submit is idempotent while pending, approval is idempotent
after the database transition, an interrupted release can be retried, rejection
removes the pending record, and the worker returns `IDLE` for pending jobs.

- [ ] **Step 3: Run the focused tests and confirm meaningful failures**

Run:

```bash
.venv/bin/python -m unittest \
  tests.test_model tests.test_spool_store tests.test_cli tests.test_worker -v
```

Expected: failures identify non-idempotent approval/release paths, not missing
imports or test setup errors.

- [ ] **Step 4: Make approval and spool release recoverable**

Implement these semantics without adding another database. Preserve the
existing approval transaction and make its idempotent branch explicit:

```python
def approve_build(self, job_id: str) -> BuildState:
    with self._transaction():
        row = self._connection.execute(
            "SELECT state FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            raise KeyError(job_id)
        current = BuildState(row["state"])
        decision = self._connection.execute(
            "SELECT decision FROM build_approvals WHERE job_id = ?", (job_id,)
        ).fetchone()
        if current is BuildState.QUEUED and decision is not None and decision["decision"] == "approved":
            return BuildState.QUEUED
        if current is not BuildState.PENDING_APPROVAL:
            raise InvalidTransition(f"cannot approve job in {current.value}")
        # Retain the existing transactional insert, transition, and audit writes.
```

`JobSpool.release(job_id)` must return successfully when the exact job is
already in `incoming`, must move `pending` to `incoming` atomically otherwise,
and must reject mismatched or absent payloads. `_decision_main()` must allow a
full UUID in `QUEUED` only for the idempotent approved-reconciliation path; a
short build code continues resolving pending jobs only.

- [ ] **Step 5: Run the focused lifecycle tests**

Run the command from Step 3.

Expected: all lifecycle, spool, CLI, and worker tests pass.

- [ ] **Step 6: Commit the lifecycle repair**

```bash
git add src/synqora_builder/{model,store,spool,cli,worker}.py \
  tests/test_{model,spool_store,cli,worker}.py docs/migration-baseline.md
git commit -m "fix: make builder approval workflow recoverable"
```

### Task 3: Repair Codex, Schema, Skill, and Permission Tests

**Files:**
- Modify: `src/synqora_builder/codex.py`
- Modify: `src/synqora_builder/skills.py`
- Create: `requirements.lock`
- Modify: `config/design.schema.json`
- Modify: `config/skills.json`
- Modify: `tests/test_codex.py`
- Modify: `tests/test_skills.py`
- Modify: `tests/test_spool_store.py`

**Interfaces:**
- Consumes: `CodexRunner`, `SkillRouter`, and strict JSON-schema validation.
- Produces: a green isolated model-runner test suite and deterministic image skill routing.

- [ ] **Step 1: Add tests for descriptor-safe workspace handling**

Change the fake process in `tests/test_codex.py` to accept the safe workspace
path supplied after `-C` and verify it resolves to the configured workspace:

```python
workspace_arg = Path(self.argv[self.argv.index("-C") + 1])
self.workspace = workspace_arg.resolve(strict=True)
self.assert_workspace = self.workspace.parent == self.expected_workspace_root.resolve()
```

Keep assertions that the real command receives a passed workspace descriptor,
network is disabled, shell tools are disabled, and model output is bounded.

- [ ] **Step 2: Add failing uniqueness and image-routing tests**

Add these expectations:

```python
self.assertTrue(design_schema["properties"]["selected_skills"]["uniqueItems"])
self.assertTrue(design_schema["properties"]["hierarchy"]["uniqueItems"])

selected = SkillRouter.from_file(self.config).route({"image_led": True})
self.assertIn("image-to-code", selected.names)
self.assertIn("imagegen-frontend-web", selected.names)
```

Update the state-file permission expectation to `0o640`, matching the approved
specification rather than the stale `0o660` assertion.

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```bash
.venv/bin/python -m unittest \
  tests.test_codex tests.test_skills tests.test_spool_store -v
```

Expected: schema uniqueness and image-generation routing fail before the
minimal production/config changes; descriptor tests no longer fail because a
directory name is not an integer.

- [ ] **Step 4: Add schema uniqueness and deterministic image routing**

Set `"uniqueItems": true` on bounded design arrays where duplicates have no
meaning: `hierarchy`, `palette`, `typography`, `asset_plan`, and
`selected_skills`. In `src/synqora_builder/skills.py`, make the image-led route
explicit:

```python
if attributes.get("image_led") is True:
    selected.extend(("image-to-code", "imagegen-frontend-web"))
```

Deduplicate through the existing canonical skill order so repeated selections
cannot change prompt order.

Create `requirements.lock` with the source runtime's verified dependency:

```text
Pillow==12.3.0
```

- [ ] **Step 5: Run the complete Python suite**

Run:

```bash
.venv/bin/python -m unittest discover -s tests -q
```

Expected: all imported and repaired tests pass. If a remaining failure reveals
a production contradiction, add a focused regression test before changing the
code; do not delete the assertion.

- [ ] **Step 6: Commit model-runner and skill repairs**

```bash
git add src/synqora_builder/{codex,skills}.py config/{design.schema,skills}.json requirements.lock \
  tests/test_{codex,skills,spool_store}.py
git commit -m "fix: align builder gates with isolated runtime"
```

### Task 4: Add the External-Delivery Interlock

**Files:**
- Create: `src/synqora_builder/external_delivery.py`
- Create: `tests/test_external_delivery.py`
- Modify: `src/synqora_builder/deploy.py`
- Modify: `src/synqora_builder/notify.py`

**Interfaces:**
- Produces: `ExternalDeliveryMode`, `external_delivery_mode(environment)`, and `require_external_delivery_live(environment)`.
- Consumed by: `deploy_main()` and `notify_main()` before filesystem scans, credential reads, runner creation, or side effects.

- [ ] **Step 1: Write failing mode-parser tests**

Create `tests/test_external_delivery.py`:

```python
import unittest
from unittest.mock import patch

from synqora_builder.external_delivery import (
    ExternalDeliveryDisabled,
    ExternalDeliveryMode,
    external_delivery_mode,
    require_external_delivery_live,
)


class ExternalDeliveryTests(unittest.TestCase):
    def test_missing_mode_is_disabled(self):
        self.assertIs(ExternalDeliveryMode.DISABLED, external_delivery_mode({}))

    def test_only_exact_live_enables_delivery(self):
        self.assertIs(ExternalDeliveryMode.LIVE, external_delivery_mode({"ELEVATE_EXTERNAL_DELIVERY": "live"}))
        for value in ("LIVE", "true", "1", " live ", "disabled", ""):
            with self.subTest(value=value):
                self.assertIs(ExternalDeliveryMode.DISABLED, external_delivery_mode({"ELEVATE_EXTERNAL_DELIVERY": value}))

    def test_disabled_guard_fails_closed(self):
        with self.assertRaises(ExternalDeliveryDisabled):
            require_external_delivery_live({})
```

- [ ] **Step 2: Run the new test and verify import failure**

Run:

```bash
.venv/bin/python -m unittest tests.test_external_delivery -v
```

Expected: ERROR because `external_delivery.py` does not exist.

- [ ] **Step 3: Implement the strict guard**

Create `src/synqora_builder/external_delivery.py`:

```python
from enum import StrEnum
from typing import Mapping


class ExternalDeliveryMode(StrEnum):
    DISABLED = "disabled"
    LIVE = "live"


class ExternalDeliveryDisabled(RuntimeError):
    pass


def external_delivery_mode(environment: Mapping[str, str]) -> ExternalDeliveryMode:
    if environment.get("ELEVATE_EXTERNAL_DELIVERY") == ExternalDeliveryMode.LIVE.value:
        return ExternalDeliveryMode.LIVE
    return ExternalDeliveryMode.DISABLED


def require_external_delivery_live(environment: Mapping[str, str]) -> None:
    if external_delivery_mode(environment) is not ExternalDeliveryMode.LIVE:
        raise ExternalDeliveryDisabled("external delivery is disabled")
```

- [ ] **Step 4: Prove deploy and notify guard before reading handoffs**

Add tests that patch `Path.glob`, `JobStore`, `load_notifier_config`, and runner
construction to raise if touched. Call `deploy_main()` and `notify_main()` with
an environment lacking the live flag and assert `ExternalDeliveryDisabled`
while every patched dependency remains uncalled.

- [ ] **Step 5: Guard both entry points at their first executable line**

At the beginning of each entry point:

```python
def deploy_main() -> int:
    require_external_delivery_live(os.environ)
    # Existing implementation follows.


def notify_main() -> int:
    require_external_delivery_live(os.environ)
    # Existing implementation follows.
```

Catch no exception inside the entry point. systemd must record a nonzero exit
when delivery is disabled.

- [ ] **Step 6: Run tests and commit**

```bash
.venv/bin/python -m unittest tests.test_external_delivery tests.test_deploy tests.test_notify -v
git add src/synqora_builder/{external_delivery,deploy,notify}.py \
  tests/test_{external_delivery,deploy,notify}.py
git commit -m "feat: fail closed on external builder delivery"
```

### Task 5: Move Operational Paths and Commands to Elevate

**Files:**
- Create: `tests/test_operational_paths.py`
- Create: `bin/elevate-preview-builder-*`
- Modify: `src/synqora_builder/model.py`
- Modify: `src/synqora_builder/cli.py`
- Modify: `src/synqora_builder/codex.py`
- Modify: `src/synqora_builder/worker.py`
- Modify: `src/synqora_builder/deploy.py`
- Modify: `src/synqora_builder/notify.py`
- Modify: `src/synqora_builder/cleanup.py`
- Modify: `config/skills.json`
- Modify: `pyproject.toml`

**Interfaces:**
- Produces: operational defaults rooted only in approved Elevate paths and local host names ending in `.preview.invalid`.

- [ ] **Step 1: Write failing operational-path tests**

Create `tests/test_operational_paths.py` that imports every public default and
asserts:

```python
APP_ROOT = "/opt/elevate-preview-builder"
STATE_ROOT = "/var/lib/elevate-preview-builder"
SPOOL_ROOT = "/var/spool/elevate-preview-builder"
WORKSPACE_ROOT = "/srv/elevate-preview-builds"

self.assertEqual(f"{job.slug}.preview.invalid", job.host)
self.assertNotIn("/var/lib/synqora-builder", repr(imported_defaults))
self.assertNotIn("/var/spool/synqora-builder", repr(imported_defaults))
self.assertNotIn("/srv/synqora-mvp-builds", repr(imported_defaults))
self.assertEqual(600.0, WorkerConfig().deadline_seconds)
```

Also scan `systemd/`, `tmpfiles/`, `config/`, and `bin/` after their migration
and permit `synqora_builder` only as the Python import namespace.

- [ ] **Step 2: Run and verify the old defaults fail**

```bash
.venv/bin/python -m unittest tests.test_operational_paths -v
```

Expected: failures list the old state, spool, workspace, skill, and host roots.

- [ ] **Step 3: Replace operational defaults without renaming imports**

Change runtime paths to the exact values in Global Constraints. Change
`BuildJob._validate_host()` to:

```python
expected = f"{slug}.preview.invalid"
if not isinstance(value, str) or value != expected:
    raise ValueError(f"host must be {expected}")
```

Rename environment variables used by destination services from
`SYNQORA_*` to `ELEVATE_BUILDER_*`. Keep compatibility aliases out of phase
one so source credentials cannot be picked up accidentally. Change
`WorkerConfig.deadline_seconds` from `1800.0` to `600.0`.

Use this exact environment mapping:

```text
SYNQORA_DEPLOY_HANDOFF   -> ELEVATE_BUILDER_DEPLOY_HANDOFF
SYNQORA_DEPLOY_ARCHIVE   -> ELEVATE_BUILDER_DEPLOY_ARCHIVE
SYNQORA_NOTIFY_HANDOFF   -> ELEVATE_BUILDER_NOTIFY_HANDOFF
SYNQORA_NOTIFY_ARCHIVE   -> ELEVATE_BUILDER_NOTIFY_ARCHIVE
SYNQORA_NOTIFIER_CONFIG  -> ELEVATE_BUILDER_NOTIFIER_CONFIG
SYNQORA_BUILDER_DB       -> ELEVATE_BUILDER_DB
SYNQORA_BUILDER_AUDIT    -> ELEVATE_BUILDER_AUDIT
SYNQORA_WRANGLER_BIN     -> ELEVATE_BUILDER_WRANGLER_BIN
SYNQORA_BUILD_ID         -> ELEVATE_BUILD_ID
SYNQORA_MVP_WORKDIR      -> ELEVATE_PREVIEW_WORKDIR
```

`GITHUB_TOKEN` and `GITHUB_OWNER` remain publisher credential names in the
inactive legacy publisher, but neither is configured or inherited in phase
one. Change the distribution name in `pyproject.toml` to
`elevate-preview-builder`; keep the import package `synqora_builder`.

- [ ] **Step 4: Add Elevate CLI wrappers**

Each executable wrapper follows this exact pattern:

```python
#!/usr/bin/env python3
from synqora_builder.cli import submit_main

raise SystemExit(submit_main())
```

Use the matching entry point for status, cancel, approve, reject, worker,
deploy, notify, and cleanup. Set executable mode `0755`. Remove old
`bin/synqora-builder-*` wrappers after tests refer only to the new names.

- [ ] **Step 5: Run the complete suite and CLI help smoke tests**

```bash
.venv/bin/python -m unittest discover -s tests -q
for command in submit status cancel approve reject; do
  .venv/bin/python "bin/elevate-preview-builder-$command" --help >/dev/null
done
```

Expected: all tests pass and every command exits zero for `--help`.

- [ ] **Step 6: Commit operational naming**

```bash
git add bin config pyproject.toml src tests/test_operational_paths.py
git commit -m "refactor: isolate builder operational paths"
```

### Task 6: Add a Disabled-by-Default Hermes Installation

**Files:**
- Create: `systemd/elevate-preview-builder-queue.path`
- Create: `systemd/elevate-preview-builder-worker.service`
- Create: `systemd/elevate-preview-builder-deploy.path`
- Create: `systemd/elevate-preview-builder-deploy.service`
- Create: `systemd/elevate-preview-builder-notify.path`
- Create: `systemd/elevate-preview-builder-notify.service`
- Create: `systemd/elevate-preview-builder-cleanup.service`
- Create: `systemd/elevate-preview-builder-cleanup.timer`
- Create: `sysusers/elevate-preview-builder.conf`
- Create: `tmpfiles/elevate-preview-builder.conf`
- Create: `deploy/install-hermes.sh`
- Create: `deploy/verify-hermes.sh`
- Create: `deploy/rollback-hermes.sh`
- Create: `tests/test_install_assets.py`

**Interfaces:**
- Produces: repeatable release installation under `/opt/elevate-preview-builder/releases/$COMMIT_SHA` and a `current` symlink.
- Consumes: a clean repository commit and no secrets.

- [ ] **Step 1: Write failing installation-asset tests**

Create `tests/test_install_assets.py` to parse every unit as text and assert:

```python
self.assertIn("User=elevate-builder", worker)
self.assertIn("MemoryMax=2G", worker)
self.assertIn("CPUQuota=150%", worker)
self.assertIn("RuntimeMaxSec=10min", worker)
self.assertIn("NoNewPrivileges=true", worker)
self.assertIn("ProtectSystem=strict", worker)
self.assertIn("CapabilityBoundingSet=", worker)
self.assertNotIn("WantedBy=multi-user.target", queue_path)
self.assertNotIn("WantedBy=multi-user.target", deploy_path)
self.assertNotIn("WantedBy=multi-user.target", notify_path)
```

Assert tmpfiles modes and owners: `0750 elevate-builder elevate-builder` for
state, cache, spool, workspace, and runtime directories; state files remain
`0640`.

- [ ] **Step 2: Run the new test and verify missing-file failure**

```bash
.venv/bin/python -m unittest tests.test_install_assets -v
```

Expected: FAIL because the Elevate unit and installation files do not exist.

- [ ] **Step 3: Create system account and directory declarations**

`sysusers/elevate-preview-builder.conf`:

```text
u elevate-builder - "Elevate preview builder" /var/lib/elevate-preview-builder /usr/sbin/nologin
```

`tmpfiles/elevate-preview-builder.conf` declares all approved paths with mode
`0750`, owner/group `elevate-builder`, except `/opt` and `/etc`, which remain
root-owned. Do not declare or create any file containing credentials.

- [ ] **Step 4: Create hardened service units**

The worker service must contain:

```ini
[Service]
Type=exec
User=elevate-builder
Group=elevate-builder
Environment=PYTHONPATH=/opt/elevate-preview-builder/current/src
Environment=PATH=/var/lib/elevate-preview-builder/bin:/usr/local/bin:/usr/bin
Environment=HOME=/var/lib/elevate-preview-builder
Environment=CODEX_HOME=/var/lib/elevate-preview-builder/.codex
Environment=ELEVATE_EXTERNAL_DELIVERY=disabled
ExecStart=/opt/elevate-preview-builder/current/bin/elevate-preview-builder-worker
RuntimeMaxSec=10min
MemoryMax=2G
CPUQuota=150%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadOnlyPaths=/opt/elevate-preview-builder
ReadWritePaths=/var/lib/elevate-preview-builder /var/cache/elevate-preview-builder /var/spool/elevate-preview-builder /srv/elevate-preview-builds
```

Deploy and notify units also set `ELEVATE_EXTERNAL_DELIVERY=disabled` and have
no `EnvironmentFile` containing publisher credentials. Path units have no
`[Install]` target, preventing normal enablement. Only the cleanup timer may be
enabled after verification.

- [ ] **Step 5: Implement the release installer**

`deploy/install-hermes.sh` must:

1. require root and a clean committed checkout;
2. derive the full commit SHA and install to
   `/opt/elevate-preview-builder/releases/$SHA`;
3. run `systemd-sysusers` and `systemd-tmpfiles --create`;
4. copy repository files without `.git`, `.venv`, `node_modules`, tests caches,
   or generated artifacts;
5. create a release-local Python venv and run `pip install --no-deps .` after
   installing `requirements.lock`;
6. run `npm ci --ignore-scripts` and Playwright browser dependency checks;
7. install Codex with
   `npm install --global --prefix /var/lib/elevate-preview-builder @openai/codex@0.144.1`;
8. install unit files but execute only `systemctl daemon-reload`;
9. atomically change `current` to the new release;
10. print unit states and fail if queue, deploy, or notify paths are enabled or
   active.

It must never call `systemctl enable --now`, `gh`, `vercel`, `wrangler`,
`hermes send`, or a voice API.

- [ ] **Step 6: Implement verification and rollback scripts**

`deploy/verify-hermes.sh` runs Python tests, Node checks, unit security checks,
ownership checks, and asserts:

```bash
test "$(systemctl is-enabled elevate-preview-builder-queue.path 2>&1 || true)" != enabled
test "$(systemctl is-active elevate-preview-builder-deploy.path 2>&1 || true)" != active
test "$(systemctl is-active elevate-preview-builder-notify.path 2>&1 || true)" != active
test "${ELEVATE_EXTERNAL_DELIVERY:-disabled}" = disabled
```

The rollback interface is:

```bash
TARGET_SHA=$(git rev-parse HEAD^)
deploy/rollback-hermes.sh "$TARGET_SHA"
```

It stops/disables all Elevate builder units, validates the requested release
directory is an exact child of `releases/`, and atomically repoints `current`.
It does not delete state.

- [ ] **Step 7: Run tests and shell syntax checks**

```bash
.venv/bin/python -m unittest tests.test_install_assets -v
bash -n deploy/install-hermes.sh deploy/verify-hermes.sh deploy/rollback-hermes.sh
```

Expected: PASS. Run `systemd-analyze verify` against the units on Hermes in
Task 9, where systemd and the absolute executable paths are available.

- [ ] **Step 8: Commit installation assets**

```bash
git add systemd sysusers tmpfiles deploy tests/test_install_assets.py
git commit -m "feat: add isolated Hermes builder installation"
```

### Task 7: Add the Internal Smoke Fixture and Complete Local Verification

**Files:**
- Create: `fixtures/smoke/request.json`
- Modify: `README.md`
- Modify: `tests/test_repository_hygiene.py`

**Interfaces:**
- Produces: a deterministic non-lead request accepted only as local preview work.

- [ ] **Step 1: Create the fixture**

Create `fixtures/smoke/request.json`:

```json
{
  "slug": "internal-smoke",
  "host": "internal-smoke.preview.invalid",
  "lead_delivery": false,
  "brief": "Create a polished one-page fictional e-commerce preview for Meridian Stationery. Show three clearly fictional products, responsive navigation, restrained motion, an approval-direction CTA with no payment, and no unsupported claims.",
  "source_urls": [],
  "assets": []
}
```

Add a test that parses it through `BuildJob.from_dict()` and asserts
`lead_delivery is False` and the reserved host is accepted.

- [ ] **Step 2: Document exact safe commands**

Update `README.md` with commands for local tests, submit, approve, status,
manual worker execution, loopback preview, and cleanup. Every example sets
`ELEVATE_EXTERNAL_DELIVERY=disabled`; no example invokes deploy or notify.

- [ ] **Step 3: Run the full local verification matrix**

```bash
.venv/bin/python -m unittest discover -s tests -q
npm ci --ignore-scripts
npm run check
npm test
git diff --check
git status --short
```

Expected: all tests and checks pass; only intentional Task 7 files are
modified before commit.

- [ ] **Step 4: Run repository hygiene after dependencies are removed**

Confirm generated dependency/cache directories are ignored and scan only
tracked repository content:

```bash
python3 -m unittest tests.test_repository_hygiene -v
git status --short --ignored
```

Expected: hygiene PASS and no generated runtime files tracked.

- [ ] **Step 5: Commit the smoke fixture and documentation**

```bash
git add fixtures README.md tests/test_repository_hygiene.py
git commit -m "test: define no-delivery builder smoke flow"
```

### Task 8: Create and Push the Private GitHub Repository

**Files:**
- No production file changes.

**Interfaces:**
- Consumes: clean, verified local `main`.
- Produces: private `Srikarsmile/elevate-preview-builder` remote at the exact local commit.

- [ ] **Step 1: Verify GitHub identity and repository absence**

```bash
gh auth status
if gh repo view Srikarsmile/elevate-preview-builder >/dev/null 2>&1; then
  echo "repository already exists; stop for reconciliation" >&2
  exit 1
fi
```

Expected: authenticated as the intended owner and repository absent. Never
delete or overwrite an existing repository.

- [ ] **Step 2: Run the final pre-push checks**

```bash
test -z "$(git status --porcelain)"
python3 -m unittest tests.test_repository_hygiene -v
git log --oneline --decorate -8
```

Expected: clean tree and hygiene PASS.

- [ ] **Step 3: Create the private repository and push**

```bash
gh repo create Srikarsmile/elevate-preview-builder \
  --private --source=. --remote=origin --push
gh repo view Srikarsmile/elevate-preview-builder \
  --json nameWithOwner,isPrivate,defaultBranchRef
```

Expected: `isPrivate: true`, default branch `main`, and `origin/main` equals
local `HEAD`.

### Task 9: Install the Repaired Builder on Hermes With All Triggers Disabled

**Files:**
- Create on VPS: release and runtime paths from Global Constraints.
- Record locally: `docs/hermes-verification.md`

**Interfaces:**
- Consumes: private GitHub repository and installation scripts.
- Produces: installed but inactive builder runtime on `srikarhermes-vps`.

- [ ] **Step 1: Capture destination safety baseline**

```bash
ssh srikarhermes-vps '
  systemctl is-active elevate-whatsapp-bridge elevate-feedback-worker hermes-gateway
  systemctl is-enabled elevate-preview-builder-queue.path 2>&1 || true
  free -h
  df -h /
'
```

Expected: existing services active, no enabled builder trigger, at least 2 GB
available memory including reclaimable cache, and at least 10 GB free disk.

- [ ] **Step 2: Clone the private repository into a root-only staging path**

Use the VPS's existing GitHub authentication without printing it:

```bash
ssh srikarhermes-vps '
  test ! -e /root/elevate-preview-builder-stage
  git clone --depth 1 git@github.com:Srikarsmile/elevate-preview-builder.git \
    /root/elevate-preview-builder-stage
  cd /root/elevate-preview-builder-stage
  git rev-parse HEAD
'
```

Expected: the commit equals local `origin/main`. If SSH authentication is not
configured, use `gh repo clone` after `gh auth status`; do not paste a token
into a command line.

- [ ] **Step 3: Run the installer**

```bash
ssh srikarhermes-vps '
  cd /root/elevate-preview-builder-stage
  sudo bash deploy/install-hermes.sh
'
```

Expected: installation succeeds and reports queue, deploy, and notify paths as
disabled/inactive.

- [ ] **Step 4: Run destination verification**

```bash
ssh srikarhermes-vps '
  cd /opt/elevate-preview-builder/current
  systemd-analyze verify systemd/*.service systemd/*.path systemd/*.timer
  sudo bash deploy/verify-hermes.sh
  systemctl list-units --all "elevate-preview-builder*" --no-pager
'
```

Expected: tests pass, all external trigger units remain inactive, and no
publisher credential file exists.

- [ ] **Step 5: Recheck existing services and commit evidence**

Record commit SHA, versions, test totals, unit states, disk/memory snapshot,
and existing-service health in `docs/hermes-verification.md`. Do not record
host IPs, tokens, briefs, or generated content.

```bash
git add docs/hermes-verification.md
git commit -m "docs: record Hermes builder installation"
git push origin main
```

### Task 10: Provision Fresh Codex Authentication and Run One Internal Build

**Files:**
- Modify on VPS: `/var/lib/elevate-preview-builder/.codex/` through Codex login only.
- Modify: `docs/hermes-verification.md`

**Interfaces:**
- Consumes: Codex CLI 0.144.1, builder-scoped home, smoke fixture, disabled triggers.
- Produces: one local approved artifact and a valid unconsumed deployment handoff.

- [ ] **Step 1: Install and verify the pinned Codex CLI**

The installer must have created a builder-owned runtime. Verify:

```bash
ssh srikarhermes-vps '
  sudo -u elevate-builder \
    HOME=/var/lib/elevate-preview-builder \
    CODEX_HOME=/var/lib/elevate-preview-builder/.codex \
    /var/lib/elevate-preview-builder/bin/codex --version
'
```

Expected: `codex-cli 0.144.1`.

- [ ] **Step 2: Authenticate the dedicated profile**

Run device authentication as the service identity:

```bash
ssh -t srikarhermes-vps '
  sudo -u elevate-builder \
    HOME=/var/lib/elevate-preview-builder \
    CODEX_HOME=/var/lib/elevate-preview-builder/.codex \
    /var/lib/elevate-preview-builder/bin/codex login --device-auth
'
```

Complete the displayed browser authorization. Do not copy
`Synqora_Srikar:/var/lib/synqora-builder/.codex` and do not expose the token.
Then run `codex login status` under the same identity and expect success.

- [ ] **Step 3: Submit and approve only the internal fixture**

```bash
ssh srikarhermes-vps '
  set -eu
  install -m 0640 -o elevate-builder -g elevate-builder \
    /opt/elevate-preview-builder/current/fixtures/smoke/request.json \
    /var/lib/elevate-preview-builder/smoke-request.json
  response=$(sudo -u elevate-builder env \
    PYTHONPATH=/opt/elevate-preview-builder/current/src \
    ELEVATE_EXTERNAL_DELIVERY=disabled \
    /opt/elevate-preview-builder/current/bin/elevate-preview-builder-submit \
      --request /var/lib/elevate-preview-builder/smoke-request.json --json)
  job_id=$(printf "%s" "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"build_id\"])")
  test "$(printf "%s" "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)[\"status\"])")" = pending_approval
  printf "%s\n" "$job_id" > /var/lib/elevate-preview-builder/smoke-job-id
  chown elevate-builder:elevate-builder /var/lib/elevate-preview-builder/smoke-job-id
  chmod 0640 /var/lib/elevate-preview-builder/smoke-job-id
  sudo -u elevate-builder env \
    PYTHONPATH=/opt/elevate-preview-builder/current/src \
    ELEVATE_EXTERNAL_DELIVERY=disabled \
    /opt/elevate-preview-builder/current/bin/elevate-preview-builder-approve \
      --job "$job_id" --json
'
```

The UUID comes only from this internal fixture.

- [ ] **Step 4: Run the worker manually with triggers still disabled**

```bash
ssh srikarhermes-vps '
  sudo systemd-run --wait --collect --pipe \
    --unit=elevate-preview-builder-smoke \
    --property=User=elevate-builder \
    --property=Group=elevate-builder \
    --property=MemoryMax=2G \
    --property=CPUQuota=150% \
    --setenv=PYTHONPATH=/opt/elevate-preview-builder/current/src \
    --setenv=PATH=/var/lib/elevate-preview-builder/bin:/usr/local/bin:/usr/bin \
    --setenv=HOME=/var/lib/elevate-preview-builder \
    --setenv=CODEX_HOME=/var/lib/elevate-preview-builder/.codex \
    --setenv=ELEVATE_EXTERNAL_DELIVERY=disabled \
    /opt/elevate-preview-builder/current/bin/elevate-preview-builder-worker
'
```

Expected: completion within ten minutes, state `deploying`, local `dist/`, gate
results, Sol review, desktop/mobile screenshots, and one deployment-handoff
manifest. Deploy and notify units remain inactive, so nothing consumes it.

- [ ] **Step 5: Verify the artifact on loopback only**

Use the repository browser gate against the generated workspace. Confirm both
screenshots have nonblank pixel counts, no overlap finding, and passing mobile
and desktop gates. If a temporary preview process is needed, bind to
`127.0.0.1` and terminate it before continuing; do not open a firewall port or
create DNS.

- [ ] **Step 6: Prove absence of external side effects**

```bash
ssh srikarhermes-vps '
  test "$(systemctl is-active elevate-preview-builder-deploy.path 2>&1 || true)" != active
  test "$(systemctl is-active elevate-preview-builder-notify.path 2>&1 || true)" != active
  test ! -e /etc/elevate-preview-builder/deploy.env
  systemctl is-active elevate-whatsapp-bridge elevate-feedback-worker hermes-gateway
  ss -lntp | rg "127.0.0.1" || true
'
```

Also verify no new repository named `synqora-preview-*`, no Vercel deployment,
no Cloudflare Pages project, no WhatsApp send record, and no outbound call was
created during the smoke-test interval.

- [ ] **Step 7: Record timings and final verification**

Add only non-sensitive stage durations, artifact digest, screenshot paths,
unit states, and existing-service health to `docs/hermes-verification.md`.

```bash
git add docs/hermes-verification.md
git commit -m "test: verify internal Hermes builder artifact"
git push origin main
git status --short --branch
```

Expected: clean worktree, `main` synchronized with the private remote, and all
phase-one acceptance criteria satisfied without external delivery.

## Final Acceptance Checklist

- [ ] Source VPS files, services, credentials, and runtime state are unchanged.
- [ ] `Srikarsmile/elevate-preview-builder` exists and is private.
- [ ] The repository contains the sanitized source, skills, provenance, tests, installation assets, and no prohibited files.
- [ ] The complete Python suite, Node checks, browser self-test, and hygiene scan pass locally and on Hermes.
- [ ] Approval is durable, explicit, idempotent, and required before queue publication.
- [ ] Deploy and notify entry points fail before reading handoffs unless delivery is exactly `live`.
- [ ] The builder runs only as `elevate-builder`, one job at a time, with `MemoryMax=2G`, `CPUQuota=150%`, and a 10-minute limit.
- [ ] Queue, deployment, and notification trigger units remain disabled and inactive.
- [ ] Fresh builder-scoped Codex authentication works without copied source credentials.
- [ ] The internal smoke build produces nonblank desktop/mobile evidence and an unconsumed local handoff.
- [ ] No GitHub preview repository, Vercel/Cloudflare deployment, WhatsApp message, public listener, DNS entry, or call is created.
- [ ] Existing voice bridge, feedback worker, Hermes gateway, callback state, and WhatsApp session remain healthy.
