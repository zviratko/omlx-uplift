# SPDX-License-Identifier: Apache-2.0
"""Tests for the Uplift overlay API (model-settings-index, prune, GET/DELETE
model settings) — package-local, vanilla routes.py no longer hosts these.

pytest asyncio_mode=auto collects these bare async tests.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

import omlx.server  # noqa: F401 - ensure server module is imported first
from omlx_uplift import router as up
from omlx.model_settings import ModelSettings


def _mgr(settings: dict):
    mgr = MagicMock()
    mgr.get_all_settings.return_value = settings
    mgr.delete_settings.side_effect = lambda mid: settings.pop(mid, None) is not None
    return mgr


def _pool(model_ids):
    pool = MagicMock()
    pool.get_model_ids.return_value = list(model_ids)
    pool.get_entry.side_effect = lambda mid: (
        MagicMock() if mid in model_ids else None
    )
    return pool


def _ms(mid, alias=None):
    s = ModelSettings()
    s.model_alias = alias
    return s


async def test_index_reports_orphans_and_aliases():
    settings = {
        "live-model": _ms("live-model", alias="alias-target"),
        "gone-model": _ms("gone-model"),
        "alias-target": _ms("alias-target"),  # referenced by live-model's alias
    }
    with patch.object(up, "settings_manager", return_value=_mgr(settings)), \
         patch.object(up, "engine_pool", return_value=_pool(["live-model"])):
        out = await up.model_settings_index(is_admin=True)
    assert out["stored"] == 3
    assert out["known"] == 1
    # gone-model is an orphan; alias-target is kept by live-model's alias
    assert out["orphans"] == ["gone-model"]
    assert {"id": "live-model", "alias": "alias-target"} in out["entries"]


async def test_index_requires_pool():
    with patch.object(up, "settings_manager", return_value=_mgr({})), \
         patch.object(up, "engine_pool", return_value=None):
        with pytest.raises(HTTPException) as ei:
            await up.model_settings_index(is_admin=True)
    assert ei.value.status_code == 503


async def test_prune_deletes_only_listed_existing_ids():
    settings = {
        "a": _ms("a"),
        "b": _ms("b"),
    }
    mgr = _mgr(settings)
    with patch.object(up, "settings_manager", return_value=mgr):
        out = await up.prune_model_settings(
            up.PruneModelSettingsRequest(ids=["a", "a", "ghost"]),
            is_admin=True,
        )
    assert out["removed"] == ["a"]
    assert out["removed_templates"] == []
    assert "b" in settings


async def test_prune_requires_ids():
    with patch.object(up, "settings_manager", return_value=_mgr({})):
        with pytest.raises(HTTPException) as ei:
            await up.prune_model_settings(
                up.PruneModelSettingsRequest(ids=[]), is_admin=True
            )
    assert ei.value.status_code == 400


async def test_get_model_settings_shape():
    mgr = MagicMock()
    s = ModelSettings()
    s.temperature = 0.42
    mgr.get_settings.return_value = s
    with patch.object(up, "settings_manager", return_value=mgr), \
         patch.object(up, "engine_pool", return_value=_pool(["m1"])):
        out = await up.get_model_settings("m1", is_admin=True)
    assert out["id"] == "m1"
    assert out["settings"]["temperature"] == 0.42


async def test_get_model_settings_unknown_404():
    with patch.object(up, "settings_manager", return_value=MagicMock()), \
         patch.object(up, "engine_pool", return_value=_pool(["other"])):
        with pytest.raises(HTTPException) as ei:
            await up.get_model_settings("ghost", is_admin=True)
    assert ei.value.status_code == 404


async def test_delete_model_settings():
    settings = {"a": _ms("a")}
    mgr = _mgr(settings)
    with patch.object(up, "settings_manager", return_value=mgr):
        out = await up.delete_model_settings_route("a", is_admin=True)
    assert out == {"deleted": "a"}
    with patch.object(up, "settings_manager", return_value=_mgr({})):
        with pytest.raises(HTTPException) as ei:
            await up.delete_model_settings_route("ghost", is_admin=True)
    assert ei.value.status_code == 404


def test_locale_overlays_key_sync():
    """Overlay key discipline, two families:
    - UI keys (shell/toast/feed): every locale must carry the full set.
    - uplift.gs.* / uplift.se.* labels: subset allowed (documented
      EN-fallback design mirroring classic's partial catalogs), but
      placeholders must match wherever a key IS present."""
    import re
    from omlx_uplift.router import _PACKAGE_LOCALES

    en = json.loads((_PACKAGE_LOCALES / "en.json").read_text(encoding="utf-8"))
    assert en, "en overlay must not be empty"
    FALLBACK_FAMILIES = ("uplift.gs.", "uplift.se.", "uplift.ui.")
    ui_en = {k: v for k, v in en.items() if not k.startswith(FALLBACK_FAMILIES)}
    langs = {"zh", "zh-TW", "ja", "ko", "ru", "es", "fr", "pt-BR"}
    for lang in langs:
        data = json.loads(((_PACKAGE_LOCALES / f"{lang}.json")).read_text(encoding="utf-8"))
        assert set(ui_en) <= set(data), f"{lang} missing UI keys: {sorted(set(ui_en) - set(data))[:5]}"
        for k, v in en.items():
            if k not in data:
                assert k.startswith(FALLBACK_FAMILIES), f"{lang}:{k} missing but not a fallback-family key"
                continue
            src = set(re.findall(r"\{(\w+)\}", v))
            got = set(re.findall(r"\{(\w+)\}", data[k]))
            assert src == got, f"{lang}:{k} placeholders {got} != en {src}"
