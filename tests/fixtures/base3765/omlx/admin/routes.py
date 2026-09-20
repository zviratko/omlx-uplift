### filler gap
### filler gap
### filler gap
            f"{'enabled' if request.memory_prefill_memory_guard else 'disabled'}"
        )

    # Apply scheduler settings (restart required)
    if request.max_concurrent_requests is not None:
        global_settings.scheduler.max_concurrent_requests = (
            request.max_concurrent_requests
        )

    # Apply embedding batch size setting (Live for loaded embedding engines)
    if request.embedding_batch_size is not None:
