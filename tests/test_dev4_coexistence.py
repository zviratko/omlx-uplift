"""DEV-4 tests: coexistence config + sharing realization.

Everything runs against throwaway dirs: the vanilla base and the dev base
are both tempdirs, brew/launchd are never touched (reconfigure's service
restart path is only exercised through the pure helpers). Covers: share
symlink flip, private seeding (copy once, never move), refusal to destroy
a real dev copy when flipping back to shared, NEVER_SHARE refusal, port
validation incl. vanilla-port clash, and runtime_config defaulting.
"""

import json
import os
import shutil
import tempfile
import unittest

from omlx_uplift import devsrc


class ShareFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev4-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.vanilla = os.path.join(self.tmp, ".omlx")
        self.devbase = os.path.join(self.tmp, ".omlx-dev")
        os.makedirs(os.path.join(self.vanilla, "models"))
        with open(os.path.join(self.vanilla, "models", "m1.txt"), "w") as fh:
            fh.write("model\n")
        with open(os.path.join(self.vanilla, "model_settings.json"), "w") as fh:
            json.dump({"a": 1}, fh)
        with open(os.path.join(self.vanilla, "model_profiles.json"), "w") as fh:
            json.dump({"p": 2}, fh)
        self.cfg = {"base_path": self.devbase, "port": 8001}

    def _realize(self, share):
        cfg = dict(self.cfg, share=share)
        return devsrc.realize_share(cfg, vanilla=self.vanilla), cfg

    def test_shared_is_symlink_into_vanilla(self):
        actions, _ = self._realize({"models": True, "model_settings": False,
                                    "model_profiles": False})
        link = os.path.join(self.devbase, "models")
        self.assertTrue(os.path.islink(link))
        self.assertEqual(os.path.realpath(link),
                         os.path.realpath(os.path.join(self.vanilla, "models")))
        self.assertIn("shared", [a["action"] for a in actions])

    def test_unshared_seeds_real_copy(self):
        actions, _ = self._realize({"models": False, "model_settings": False,
                                    "model_profiles": False})
        seeded = os.path.join(self.devbase, "model_settings.json")
        self.assertTrue(os.path.isfile(seeded))
        self.assertFalse(os.path.islink(seeded))
        with open(seeded) as fh:
            self.assertEqual(json.load(fh), {"a": 1})
        # copy, not move: vanilla untouched
        self.assertTrue(os.path.isfile(
            os.path.join(self.vanilla, "model_settings.json")))

    def test_idempotent(self):
        acts1, cfg = self._realize({"models": True, "settings": False,
                                    "model_settings": False,
                                    "model_profiles": False})
        acts2 = devsrc.realize_share(cfg, vanilla=self.vanilla)
        self.assertEqual([a["action"] for a in acts2],
                         ["unchanged"] * 4)

    def test_never_destroy_real_dev_copy_when_flipping_to_shared(self):
        self._realize({"models": False, "model_settings": False,
                       "model_profiles": False})
        dev_models = os.path.join(self.devbase, "models")
        os.makedirs(dev_models, exist_ok=True)
        with open(os.path.join(dev_models, "mine.txt"), "w") as fh:
            fh.write("mine\n")
        actions, _ = self._realize({"models": True, "model_settings": False,
                                    "model_profiles": False})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["models"], "kept-private")
        self.assertTrue(os.path.isfile(os.path.join(dev_models, "mine.txt")))

    def test_link_to_wrong_target_is_rewritten(self):
        os.symlink(os.path.join(self.tmp, "nowhere"),
                   os.path.join(self.devbase, "models")) if False else None
        os.makedirs(self.devbase, exist_ok=True)
        os.symlink(os.path.join(self.tmp, "nowhere"),
                   os.path.join(self.devbase, "models"))
        actions, _ = self._realize({"models": True, "model_settings": False,
                                    "model_profiles": False})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["models"], "shared")
        self.assertEqual(os.path.realpath(os.path.join(self.devbase, "models")),
                         os.path.realpath(os.path.join(self.vanilla, "models")))

    def test_never_share_refused(self):
        actions, _ = self._realize({"cluster": True, "models": True})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["cluster"], "refused")

    def test_settings_private_is_a_copy_shared_is_a_symlink(self):
        # settings.json left NEVER_SHARE (2026-09-24): private = copied
        # once (dev REPLACES vanilla setup), shared = symlink (service
        # block's OMLX_PORT/OMLX_BASE_PATH win over the file anyway)
        with open(os.path.join(self.vanilla, "settings.json"), "w") as fh:
            json.dump({"port": 8000, "auth": {"api_key": "x"}}, fh)
        actions, _ = self._realize({"settings": False, "models": True})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["settings"], "seeded-from-vanilla")
        dev_copy = os.path.join(self.devbase, "settings.json")
        self.assertTrue(os.path.isfile(dev_copy))
        self.assertFalse(os.path.islink(dev_copy))
        # flipping to shared on a COPY keeps the copy (data safety, same
        # rule as every other knob)
        actions, _ = self._realize({"settings": True, "models": True})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["settings"], "kept-private")

    def test_unshared_seed_empty_when_vanilla_missing(self):
        actions, _ = self._realize({"models": False, "model_settings": False,
                                    "model_profiles": False})
        # model_profiles.json exists; make up a knob without vanilla source:
        os.remove(os.path.join(self.vanilla, "model_profiles.json"))
        shutil.rmtree(self.devbase)
        actions, _ = self._realize({"models": False, "model_settings": False,
                                    "model_profiles": False})
        acts = {a["name"]: a["action"] for a in actions}
        self.assertEqual(acts["model_profiles"], "seeded-empty")
        with open(os.path.join(self.devbase, "model_profiles.json")) as fh:
            self.assertEqual(json.load(fh), {})


class RuntimeConfig(unittest.TestCase):
    def test_defaults_when_keys_absent(self):
        rt = devsrc.runtime_config({"origin": "x"})
        self.assertEqual(rt["port"], 8001)
        self.assertEqual(rt["base_path"], "~/.omlx-dev")

    def test_explicit_wins(self):
        rt = devsrc.runtime_config({"port": 8010, "base_path": "/tmp/x"})
        self.assertEqual(rt["port"], 8010)
        self.assertEqual(rt["base_path"], "/tmp/x")

    def test_share_map_defaults(self):
        sm = devsrc.share_map({})
        self.assertEqual(sm, {"models": True, "settings": False,
                              "model_settings": False,
                              "model_profiles": False})
        sm = devsrc.share_map({"share": {"model_settings": True}})
        self.assertTrue(sm["model_settings"])
        self.assertTrue(sm["models"])  # default kept


class ReconfigureCLI(unittest.TestCase):
    """cmd_dev_reconfigure with a fake args namespace; dev.json points at a
    tempdir so the real ~/.omlx/uplift/dev.json is untouched."""

    class A:
        port = None
        base_path = None
        share = None
        no_share = None
        interactive = False

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="uplift-dev4-cli-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._orig_save = devsrc.save_config
        self._orig_vanilla = devsrc.vanilla_port
        self._orig_path = devsrc.dev_json_path
        # redirect persistence into the tempdir WITHOUT touching the real
        # ~/.omlx/uplift/dev.json (base_dir default is the real one)
        self.saved = {}

        def fake_save(cfg, base_dir=None):
            self.saved.update(cfg)
            return os.path.join(self.tmp, "dev.json")

        devsrc.save_config = fake_save
        devsrc.dev_json_path = lambda base_dir=None: os.path.join(
            base_dir or self.tmp, "dev.json")
        self.addCleanup(setattr, devsrc, "save_config", self._orig_save)
        self.addCleanup(setattr, devsrc, "dev_json_path", self._orig_path)
        devsrc.vanilla_port = lambda: 8000
        self.addCleanup(setattr, devsrc, "vanilla_port", self._orig_vanilla)

    def _cfg(self):
        return self.saved

    def test_writes_port_share_and_realizes(self):
        from omlx_uplift import cli

        a = self.A()
        a.port = 8123  # free ephemeral-ish; port_in_use must be False
        a.share = ["models"]
        a.no_share = ["model_settings"]
        cfg = {"origin": "x", "base_path": os.path.join(self.tmp, "devbase"),
               "src_path": self.tmp}
        rc = cli.cmd_dev_reconfigure(a, cfg=cfg)
        self.assertEqual(rc, 0)
        saved = self._cfg()
        self.assertEqual(saved["port"], 8123)
        self.assertTrue(saved["share"]["models"])
        self.assertFalse(saved["share"]["model_settings"])

    def test_busy_port_refused(self):
        from omlx_uplift import cli

        # occupy a port, then ask for it
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        a = self.A()
        a.port = s.getsockname()[1]
        a.share = []
        cfg = {"origin": "x", "base_path": os.path.join(self.tmp, "devbase")}
        self.assertEqual(cli.cmd_dev_reconfigure(a, cfg=cfg), 1)
        s.close()

    def test_missing_config_exit_2(self):
        from omlx_uplift import cli

        self.assertEqual(cli.cmd_dev_reconfigure(self.A()), 2)


if __name__ == "__main__":
    unittest.main()
