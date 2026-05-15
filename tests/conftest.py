"""Common pytest fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from robomp.config import Settings, reset_settings_cache
from robomp.dashboard import reset_index_cache, static_dir
from robomp.db import Database, close_database

# Minimum HTML the dashboard handler needs to render: `<title>` plus a script
# block carrying the `__ROBOMP_CONFIG__` sentinel. The real Vite-built bundle
# adds JS/CSS asset links; tests only care about the rendering contract.
_PLACEHOLDER_INDEX_HTML = (
    "<!doctype html>\n"
    '<html lang="en">\n'
    '  <head><meta charset="utf-8"><title>robomp</title></head>\n'
    "  <body>\n"
    '    <div id="app"></div>\n'
    '    <script id="robomp-config" type="application/json">__ROBOMP_CONFIG__</script>\n'
    "  </body>\n"
    "</html>\n"
)


@pytest.fixture(autouse=True, scope="session")
def _ensure_dashboard_bundle() -> None:
    """Guarantee a renderable dashboard bundle for the whole session.

    The real bundle is produced by `bun run web:build`; CI and fresh clones
    might not have run it yet. We only synthesise an `index.html` when one
    isn't already present, so a developer's locally-built bundle isn't
    clobbered by the test run.
    """
    directory = static_dir()
    index = directory / "index.html"
    if not index.exists():
        index.write_text(_PLACEHOLDER_INDEX_HTML, encoding="utf-8")
    reset_index_cache()


def _baseline_env(tmp_path: Path) -> dict[str, str]:
    return {
        # Orchestrator-mode: no PAT in this container; talk to gh-proxy instead.
        "ROBOMP_GH_PROXY_URL": "http://gh-proxy.invalid:8081",
        "ROBOMP_GH_PROXY_HMAC_KEY": "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "GITHUB_WEBHOOK_SECRET": "test-webhook-secret",
        "ROBOMP_BOT_LOGIN": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_NAME": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "ROBOMP_REPO_ALLOWLIST": "octo/widget",
        "ROBOMP_MODEL": "anthropic/claude-sonnet-4-5",
        "ROBOMP_THINKING": "high",
        "ROBOMP_WORKSPACE_ROOT": str(tmp_path / "workspaces"),
        "ROBOMP_SQLITE_PATH": str(tmp_path / "robomp.sqlite"),
        "ROBOMP_LOG_DIR": str(tmp_path / "logs"),
    }


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    env = _baseline_env(tmp_path)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    # Defensive: a stray `.env` or shell export must not flip us into PAT mode.
    # `monkeypatch.delenv` would let pydantic_settings fall back to the .env
    # file; setenv("") is what actually shadows the file value, and the
    # `_blank_token_disables` validator treats empty strings as unset.
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield env
    reset_settings_cache()
    close_database()


@pytest.fixture
def proxy_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    """Baseline env for the gh-proxy container: holds the PAT, no proxy vars."""
    baseline = _baseline_env(tmp_path)
    baseline.pop("ROBOMP_GH_PROXY_URL", None)
    baseline.pop("ROBOMP_GH_PROXY_HMAC_KEY", None)
    baseline["GITHUB_TOKEN"] = "ghp_test_token_value_xxxxxxxxxxxxxxxx"
    for key, value in baseline.items():
        monkeypatch.setenv(key, value)
    # Same defense-in-depth as `env`: setenv("") rather than delenv so
    # pydantic_settings doesn't fall back to the on-disk `.env` file.
    monkeypatch.setenv("ROBOMP_GH_PROXY_URL", "")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield baseline
    reset_settings_cache()
    close_database()


@pytest.fixture
def settings(env: dict[str, str]) -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


@pytest.fixture
def db(tmp_path: Path) -> Database:
    path = tmp_path / "test.sqlite"
    database = Database(path)
    yield database
    database.close()
