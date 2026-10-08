# Makes bench_tasks a real package so setuptools includes it in wheels —
# without __init__.py, find_packages() skipped the directory and the
# mteb_run.py subprocess runner silently vanished from installed builds
# (it still worked from a repo checkout, which hid the gap).
