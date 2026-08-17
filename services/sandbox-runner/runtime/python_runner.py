import asyncio
import contextlib
import importlib.util
import inspect
import json
import os
import sys


entrypoint = sys.argv[1] if len(sys.argv) > 1 else ""
if not entrypoint.startswith("/workspace/"):
    raise RuntimeError("Invalid Python entrypoint")

sys.path.insert(0, "/workspace")
sys.path.insert(0, os.path.dirname(entrypoint))
spec = importlib.util.spec_from_file_location("atypica_skill", entrypoint)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load Python entrypoint")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
main = getattr(module, "main", None)
if not callable(main):
    raise RuntimeError("Python Skill must export main(input)")

payload = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    output = main(payload)
    if inspect.isawaitable(output):
        output = asyncio.run(output)
sys.stdout.write(json.dumps(output, separators=(",", ":"), ensure_ascii=False))
