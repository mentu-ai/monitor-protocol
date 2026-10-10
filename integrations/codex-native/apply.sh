#!/usr/bin/env bash
# Apply the reviewed source patch to its exact, clean upstream checkout.
set -euo pipefail

usage() {
  printf 'Usage: %s /path/to/clean/openai-codex-checkout\n' "$0"
}

if [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  usage
  exit 0
fi
if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 - "$bundle_dir" "$1" <<'PY'
import hashlib
import json
import pathlib
import re
import subprocess
import sys

BASE = "4aa94dce270de668eff6e2fa8585c82385e84455"
UPSTREAM = "https://github.com/openai/codex"


def fail(message):
    raise SystemExit(f"Refused: {message}")


bundle = pathlib.Path(sys.argv[1]).resolve()
checkout = pathlib.Path(sys.argv[2]).expanduser().resolve()
if not checkout.is_dir():
    fail("checkout directory does not exist")


def git(*args, input_bytes=None):
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(checkout), *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        fail(f"git {args[0]} failed" + (f": {detail}" if detail else ""))
    return result.stdout


def require_clean_base():
    top = pathlib.Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve()
    if top != checkout:
        fail("pass the checkout root, not a subdirectory")
    head = git("rev-parse", "--verify", "HEAD").decode().strip()
    if head != BASE:
        fail(f"expected HEAD {BASE}; found {head}")
    if git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"):
        fail("checkout has staged, unstaged, or untracked changes; use a clean checkout")


try:
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    if manifest["format_version"] != 1:
        fail("unsupported manifest format")
    if manifest["upstream"] != {"repository": UPSTREAM, "commit": BASE}:
        fail("manifest upstream does not match this script's pinned revision")
    patch_name = manifest["patch"]["file"]
    digest = manifest["patch"]["sha256"]
except (OSError, ValueError, KeyError, TypeError):
    fail("manifest.json is missing or invalid")

if not isinstance(patch_name, str) or not patch_name or pathlib.Path(patch_name).name != patch_name:
    fail("manifest patch file must be a filename within this bundle")
if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
    fail("manifest patch SHA-256 has not been finalized")
patch_path = bundle / patch_name
if patch_path.is_symlink() or not patch_path.is_file():
    fail("manifest patch is missing or is a symlink")
try:
    patch = patch_path.read_bytes()
except OSError:
    fail("manifest patch cannot be read")
if hashlib.sha256(patch).hexdigest() != digest:
    fail("patch SHA-256 does not match manifest.json")

# The exact verified bytes are checked and applied through stdin. Do not fetch,
# reset, stage, build, execute a model, or modify an installed Codex binary.
require_clean_base()
git("apply", "--check", "-", input_bytes=patch)
require_clean_base()
git("apply", "-", input_bytes=patch)
print(f"Applied verified native monitor preview to {checkout}")
print("Source changes are unstaged. Review and run the documented tests before building.")
PY
