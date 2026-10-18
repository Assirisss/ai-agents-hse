"""Load backend-only credentials and invoke the deployment client (no local inference)."""

import os
from pathlib import Path
import sys

from dotenv import load_dotenv


def curl_upload(tar_path, url, tarball_size, progress_callback=None):
    """Use system TLS for uploads when this Python's OpenSSL transport fails."""
    import json
    import subprocess

    # The short-lived signed URL goes through stdin, never process arguments/logs.
    result = subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--connect-timeout", "20",
        "--max-time", "600", "--upload-file", str(tar_path),
        "--header", f"Content-Length: {tarball_size}",
        "--header", "Content-Type: application/gzip", "--config", "-",
    ], input=f"url = {json.dumps(url)}\n", text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Build upload failed (curl exit {result.returncode}).")
    if progress_callback:
        progress_callback(tarball_size)


def main():
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / "backend" / ".env")
    if not os.environ.get("RUNPOD_API_KEY"):
        raise SystemExit("Set RUNPOD_API_KEY in backend/.env before deploying.")
    if "--curl-upload" in sys.argv:
        sys.argv.remove("--curl-upload")
        from importlib import import_module
        upload_module = import_module("runpod_flash.core.resources.app")
        upload_module._upload_tarball = curl_upload
        from runpod_flash.cli.main import app
        app()
        return
    flash = Path(sys.executable).parent / "flash"
    os.execv(str(flash), [str(flash), *sys.argv[1:]])


if __name__ == "__main__":
    main()
