#!/usr/bin/env python3
"""Run the isolated, standard-library regression checks."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
for check in sorted((root / "tests").glob("test_*.py")):
    print(check.name, flush=True)
    subprocess.run([sys.executable, str(check)], cwd=root, check=True)
