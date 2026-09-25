"""UP-3 tests: boot-time log buffer keeps patchsync INFO lines until the
server's logging exists, then re-emits them exactly once."""

import logging
import unittest

from omlx_uplift import bootlog


class BootLogBufferTests(unittest.TestCase):
    def setUp(self):
        bootlog._instance = None            # fresh state per test
        self.logger = logging.getLogger("omlx_uplift")
        self.saved_level = self.logger.level
        self.saved_handlers = list(self.logger.handlers)
        self.logger.handlers = []      # isolated: no inherited handlers here

    def tearDown(self):
        bootlog._instance = None
        self.logger.handlers = self.saved_handlers
        self.logger.setLevel(self.saved_level)

    def test_buffers_and_reemits_once_after_config(self):
        # Boot world: no handlers anywhere, root at WARNING (pre-config).
        root = logging.getLogger()
        saved_root = (root.level, list(root.handlers))
        root.setLevel(logging.WARNING)
        root.handlers = []
        try:
            bootlog.install()
            logging.getLogger("omlx_uplift.patchsync").info(
                "reconcile done: 2 report(s)")
            self.assertIsNotNone(bootlog._instance)
            self.assertEqual(len(bootlog._instance.records), 1)

            # omlx configures logging (basicConfig -> StreamHandler+INFO).
            import io
            stream = io.StringIO()
            h = logging.StreamHandler(stream)
            h.setLevel(logging.INFO)
            root.addHandler(h)
            root.setLevel(logging.INFO)

            bootlog.flush()
            out = stream.getvalue()
            self.assertIn("reconcile done: 2 report(s)", out)
            # detached + idempotent: nothing re-emits, buffer is gone
            self.assertIsNone(bootlog._instance)
            bootlog.flush()
            self.assertEqual(stream.getvalue(), out)
            # level handed back to the inheritance chain
            self.assertEqual(self.logger.level, logging.NOTSET)
        finally:
            root.setLevel(saved_root[0])
            root.handlers = saved_root[1]

    def test_skips_when_logging_already_configured(self):
        # Warm interpreter (dev run/tests): a handler already exists —
        # buffering would double-log, so install() must be a no-op.
        root = logging.getLogger()
        saved = list(root.handlers)
        root.addHandler(logging.NullHandler())
        try:
            bootlog.install()
            self.assertIsNone(bootlog._instance)
        finally:
            root.handlers = saved

    def test_install_is_idempotent_and_flush_safe_without_install(self):
        bootlog.install()
        first = bootlog._instance
        bootlog.install()
        self.assertIs(bootlog._instance, first)
        bootlog.flush()
        bootlog.flush()          # second flush must not raise


if __name__ == "__main__":
    unittest.main()
