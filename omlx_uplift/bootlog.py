"""Boot-time log buffer — UP-3: make startup patch logs survive.

The autopatch .pth runs patchsync.sync_at_startup() at interpreter
startup: no logging config exists yet (omlx/cli.py calls basicConfig and
configure_file_logging later), so every INFO line the patch engine emits
there — `reconcile done: ...`, `uplift boot sync: ...` — hits a
handler-less logger and is dropped. The single most interesting lifecycle
event (what the patch engine did at boot) was unloggable as wired.

Fix: while no file handler exists, buffer omlx_uplift records in memory;
when Uplift mounts (register(), which necessarily runs after omlx's
logging config), re-emit the buffered records so they propagate to the
real handlers and land in server.log. Records emitted before any flush
point on a process that never mounts (plain `python -c "import ...") are
simply lost, exactly like before — nothing new is written late.

Re-emitting goes through the ORIGINAL logger (logging.warn-style call),
not handle(): handlers are attached to the root logger, so propagation is
the only way the records reach the file handler.

Stdlib only, never raises.
"""

import logging

_BUFFER_MAX = 500          # generous cap; startup emits tens, not hundreds

_instance = None           # type: BootLogBuffer | None


class _BootLogBuffer(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.INFO)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        if len(self.records) < _BUFFER_MAX:
            self.records.append(record)


def _logging_is_configured() -> bool:
    """True when some real handler already exists above our logger — then
    buffering is pointless (and would double-log): dev CLI runs, tests, or
    a register() call after logging setup on a warm interpreter."""
    lg: logging.Logger | None = logging.getLogger("omlx_uplift")
    while lg is not None:
        for h in lg.handlers:
            if _instance is None or h is not _instance:
                return True
        lg = lg.parent
    return False


def install() -> None:
    """Attach the buffer to the omlx_uplift logger if logging is still
    unconfigured. Idempotent; safe on every interpreter that imports the
    package via .pth (flush only ever happens when Uplift actually mounts).
    """
    global _instance
    try:
        if _instance is not None or _logging_is_configured():
            return
        lg = logging.getLogger("omlx_uplift")
        buf = _BootLogBuffer()
        # Root sits at WARNING pre-config — INFO records would be dropped
        # at isEnabledFor() before ANY handler sees them. Raise just our
        # subtree for the boot window; flush() hands level back to the
        # inheritance chain (root INFO from omlx's basicConfig).
        lg.setLevel(logging.INFO)
        lg.addHandler(buf)
        _instance = buf
    except Exception:
        _instance = None


def flush() -> None:
    """Re-emit buffered records through their original loggers (so they
    propagate to the now-configured handlers) and detach the buffer.
    Idempotent; never raises."""
    global _instance
    buf, _instance = _instance, None
    if buf is None:
        return
    try:
        logging.getLogger("omlx_uplift").removeHandler(buf)
        # Hand the level back to the inheritance chain: after boot the
        # user's configured level (root) decides what omlx_uplift logs.
        logging.getLogger("omlx_uplift").setLevel(logging.NOTSET)
    except Exception:
        pass
    for rec in buf.records:
        try:
            logging.getLogger(rec.name).log(
                rec.levelno, rec.getMessage(), exc_info=rec.exc_info)
        except Exception:
            pass
    buf.records.clear()
