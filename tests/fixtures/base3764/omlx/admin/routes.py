### filler gap
### filler gap
### filler gap
            ),
        )
    # Apply cache settings
    cache_changed = False
    if request.cache_enabled is not None:
        global_settings.cache.enabled = request.cache_enabled
        cache_changed = True
    if request.ssd_cache_dir is not None:
        global_settings.cache.ssd_cache_dir = request.ssd_cache_dir
        cache_changed = True
    if request.ssd_cache_max_size is not None:
        global_settings.cache.ssd_cache_max_size = request.ssd_cache_max_size
        cache_changed = True
    if request.hot_cache_only is not None:
        global_settings.cache.hot_cache_only = request.hot_cache_only
        cache_changed = True
    if request.hot_cache_write_through is not None:
        global_settings.cache.hot_cache_write_through = (
            request.hot_cache_write_through
        )
        cache_changed = True
    if requested_storage is not None:
        global_settings.cache.set_gdn_snapshot_storage(requested_storage)
        cache_changed = True
    elif request.gdn_ssd_split_enabled is not None:
        global_settings.cache.gdn_ssd_split_enabled = request.gdn_ssd_split_enabled
        cache_changed = True
    if request.gdn_ssd_pending_max_size is not None:
        global_settings.cache.gdn_ssd_pending_max_size = (
            request.gdn_ssd_pending_max_size
        )
        cache_changed = True
    if request.gdn_sidecar_precision is not None:
        global_settings.cache.gdn_sidecar_state_dtype = (
            request.gdn_sidecar_precision.lower()
        )
        cache_changed = True
    if request.hot_cache_max_size is not None:
        global_settings.cache.hot_cache_max_size = request.hot_cache_max_size
        cache_changed = True
    if request.initial_cache_blocks is not None:
        global_settings.cache.initial_cache_blocks = request.initial_cache_blocks
        cache_changed = True
    # No cache_changed: reloading models cannot re-arm the native gate, which
    # reads the env var once at the first ANE compile of the process. The env
    # update covers a process that has not compiled yet; otherwise restart.
