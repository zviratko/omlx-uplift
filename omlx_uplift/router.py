"""Uplift HTTP surface — facade (SPLIT-1).

The routes themselves live in omlx_uplift/routers/{base,pages,apiinfo,
settings,derive,metrics,requests,policy,patches,dev,skins,bench,chat}.py. This
module imports the domain modules IN THEIR ORIGINAL FILE ORDER, which
is what fixes api_router registration order — on the /admin/api alias
mount, duplicate paths resolve in registration order (vanilla
registers before uplift and wins; our own literals are ordered so
specific routes outrank dynamic ones, e.g. /requests/stats before
/requests/{request_id}). Do not reorder these imports without
re-running the route-surface diff.

Names are re-exported for compatibility (viewer, tests, dev tooling).
NOTE: monkeypatch targets must point at the OWNING domain module —
handlers resolve globals in their own module, not through here.
"""

from __future__ import annotations

from .routers.base import (api_router, page_router, require_admin, _RedirectToLogin,
                          STATIC_DIR, _no_api_cache, engine_pool, settings_manager,
                          global_settings, _require_settings_manager)
from .routers.pages import (
    LOGIN_BLOCK_MAX_S, LOGIN_BLOCK_S, LOGIN_FAIL_LIMIT, LoginRequest, _LOGIN_HTML, _MEDIA_TYPES,
    _compare_keys, _gate, _login_blocked, _login_failed, _login_fails, _login_ok,
    _login_page, _not_modified, _serve_index, _static_etag, _static_file, uplift_index,
    uplift_index_legacy, uplift_login, uplift_login_page, uplift_root, uplift_root_legacy, uplift_static,
    uplift_static_legacy,
)
from .routers.apiinfo import (
    _LANG_RE, _PACKAGE_LOCALES, _read_json_dict, _safe_lang, load_locale, locale_catalog,
    serving_identity,
)
from .routers.settings import (
    PruneModelSettingsRequest, delete_deferred_settings_route, delete_model_settings_route, get_deferred_settings_route, get_model_settings, list_model_profiles_any,
    model_settings_index, models_overlay, prune_model_settings, put_deferred_settings_route, upsert_model_profile, upsert_model_settings,
)
from .routers.derive import (
    MAX_SERIES_POINTS, _HOURLY_DERIVE, _USAGE_COLS, _downsample, _hourly_points, _parse_window,
)
from .routers.metrics import (
    metrics_hot, metrics_latest, metrics_series, metrics_live, metrics_stream, requests_stats,
)
from .routers.requests import (
    _decode_prompt_ids, cancel_request, list_requests, request_detail, requests_models, search_requests,
    stream_requests,
)
from .routers.policy import (
    RetentionRequest, get_env_overrides, get_retention, put_env_overrides, set_retention,
)
from .routers.patches import (
    PatchAddRequest, PatchApproveRequest, PatchConfigRequest, PatchIdRequest, PatchVersionRequest, _patch_tree_root,
    patch_store, patches_add, patches_check, patches_config, patches_curated, patches_curated_adopt,
    patches_curated_sync, patches_diff, patches_disable, patches_enable, patches_promote, patches_remove,
    patches_rollback, patches_test, patches_view,
)
from .routers.dev import (
    DevAutoUpdateRequest, DevBaseRequest, DevBootstrapRequest, DevBuildRequest, DevReconfigureRequest, ServerRestartRequest,
    _DEV_BOOT, _DEV_BUILD, _DEV_BUILD_LOCK, _dev11_evaluate, _dev_boot_run, _dev_boot_state,
    _dev_build_run, _dev_reconfigure_sync, _dev_service_age, _dev_share_realized, _dev_status_sync, _iso_to_epoch,
    _supervisor_kind, dev11_boot_check, dev_auto_update, dev_base, dev_bootstrap, dev_build,
    dev_commits, dev_reconfigure, dev_restart, dev_status, server_restart,
)
from .routers.skins import (
    skin_res, skin_theme_css, skins_list,
)
# NAT-3: native Bench/Chat surface route trees (501 stubs until REPL-1..4 /
# NAT-4 fill them). Registered LAST: none of their literals collide with the
# dynamic shapes above, and appending keeps the SPLIT-1 order comment's
# original-file mapping intact for every pre-existing block.
from .routers.bench import (
    bench_flag, bench_start, bench_active, bench_stream, bench_cancel, bench_results,
    bench_accuracy_add, bench_accuracy_queue, bench_accuracy_results,
    bench_context_start, bench_context_active, bench_ane_start, bench_ane_results,
)
from .routers.chat import (
    chat_key, chat_history, chat_history_save,
)

__all__ = [
    'DevAutoUpdateRequest', 'DevBaseRequest', 'DevBootstrapRequest', 'DevBuildRequest', 'DevReconfigureRequest', 'LOGIN_BLOCK_MAX_S',
    'LOGIN_BLOCK_S', 'LOGIN_FAIL_LIMIT', 'LoginRequest', 'MAX_SERIES_POINTS', 'PatchAddRequest', 'PatchApproveRequest',
    'PatchConfigRequest', 'PatchIdRequest', 'PatchVersionRequest', 'PruneModelSettingsRequest', 'RetentionRequest', 'STATIC_DIR',
    'ServerRestartRequest', '_DEV_BOOT', '_DEV_BUILD', '_DEV_BUILD_LOCK', '_HOURLY_DERIVE', '_LANG_RE',
    '_LOGIN_HTML', '_MEDIA_TYPES', '_PACKAGE_LOCALES', '_RedirectToLogin', '_USAGE_COLS', '_compare_keys',
    '_decode_prompt_ids', '_dev11_evaluate', '_dev_boot_run', '_dev_boot_state', '_dev_build_run', '_dev_reconfigure_sync',
    '_dev_service_age', '_dev_share_realized', '_dev_status_sync', '_downsample', '_gate', '_hourly_points',
    '_iso_to_epoch', '_login_blocked', '_login_failed', '_login_ok', '_login_page', '_no_api_cache',
    '_not_modified', '_parse_window', '_patch_tree_root', '_read_json_dict', '_require_settings_manager', '_safe_lang',
    '_serve_index', '_static_etag', '_static_file', '_supervisor_kind', 'api_router', 'cancel_request',
    'delete_deferred_settings_route', 'delete_model_settings_route', 'dev11_boot_check', 'dev_auto_update', 'dev_base', 'dev_bootstrap',
    'dev_build', 'dev_commits', 'dev_reconfigure', 'dev_restart', 'dev_status', 'engine_pool',
    'get_deferred_settings_route', 'get_env_overrides', 'get_model_settings', 'get_retention', 'global_settings', 'list_model_profiles_any',
    'list_requests', 'load_locale', 'locale_catalog', 'metrics_hot', 'metrics_latest', 'metrics_series', 'metrics_live', 'metrics_stream',
    'model_settings_index', 'models_overlay', 'page_router', 'patch_store', 'patches_add', 'patches_check',
    'patches_config', 'patches_curated', 'patches_curated_adopt', 'patches_curated_sync', 'patches_diff', 'patches_disable',
    'patches_enable', 'patches_promote', 'patches_remove', 'patches_rollback', 'patches_test', 'patches_view',
    'prune_model_settings', 'put_deferred_settings_route', 'put_env_overrides', 'request_detail', 'requests_models', 'requests_stats',
    'search_requests', 'server_restart', 'serving_identity', 'set_retention', 'settings_manager', 'skin_res',
    'skin_theme_css', 'skins_list', 'stream_requests', 'uplift_index', 'uplift_index_legacy', 'uplift_login',
    'uplift_login_page', 'uplift_root', 'uplift_root_legacy', 'uplift_static', 'uplift_static_legacy', 'upsert_model_profile',
    'upsert_model_settings',
]
