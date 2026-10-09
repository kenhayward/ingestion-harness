from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def specs_dir() -> Path:
    return REPO_ROOT / "specs"


@pytest.fixture
def fixture_specs_dir() -> Path:
    """Test-only specs (pipeline mechanics), independent of the specs shipped in /specs."""
    return Path(__file__).parent / "fixtures" / "specs"


@pytest.fixture
def llm_config_path() -> Path:
    return REPO_ROOT / "config" / "llm-providers.yaml"
