#!/usr/bin/env bash
# Repository secret scan (no external service, no network). Scans every TRACKED file (`git ls-files`) for:
#   * tracked .env files (only *.example may be tracked)
#   * private key blocks
#   * well-known provider/token shapes (OpenAI/OpenRouter `sk-`, Groq `gsk_`, LangSmith `lsv2_`, AWS `AKIA`, GitHub `gh?_`, Slack `xox?-`, Google `AIza`)
#   * high-entropy values assigned to *_KEY / *_SECRET / *_TOKEN / *_PASSWORD names
# Allow-list: files matching a glob in scripts/secret-scan-allow.txt (tests, lockfiles, examples) and lines containing `secret-scan:allow`.
# Usage: [SECRET_SCAN_INCLUDE_UNTRACKED=1] scan-secrets.sh [repo-root]   (default: tracked files only; set the variable to also scan new unignored files)      Exit code 0 = clean, 1 = findings, 2 = usage/environment error.
# Findings print the file, line and rule only — never the matched value.
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOW="${SECRET_SCAN_ALLOW:-$HERE/secret-scan-allow.txt}"

cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "scan-secrets: $ROOT is not a git repository" >&2; exit 2; }
command -v python3 >/dev/null || { echo "scan-secrets: python3 is required" >&2; exit 2; }

if [ "${SECRET_SCAN_INCLUDE_UNTRACKED:-0}" = 1 ]; then LIST=(git ls-files -z --cached --others --exclude-standard); else LIST=(git ls-files -z); fi
"${LIST[@]}" | SECRET_SCAN_ALLOW="$ALLOW" python3 -c '
import fnmatch, math, os, re, sys

allow = []
path = os.environ["SECRET_SCAN_ALLOW"]
if os.path.exists(path):
    allow = [l.strip() for l in open(path) if l.strip() and not l.startswith("#")]

def allowed(p: str) -> bool:
    return any(fnmatch.fnmatch(p, g) for g in allow)

SHAPES = [
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY")),
    ("openai-style-key", re.compile(r"\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{20,}")),
    ("groq-key", re.compile(r"\bgsk_[A-Za-z0-9]{20,}")),
    ("langsmith-key", re.compile(r"\blsv2_(?:pt|sk)_[A-Za-z0-9_]{16,}")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
]
ASSIGN = re.compile(r"""([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)["\x27]?\s*[:=]\s*["\x27]?([A-Za-z0-9+/=_.-]{32,})""", re.I)

def entropy(s: str) -> float:
    return -sum((s.count(c) / len(s)) * math.log2(s.count(c) / len(s)) for c in set(s))

findings = []
for raw in sys.stdin.buffer.read().split(b"\0"):
    if not raw:
        continue
    p = raw.decode()
    name = os.path.basename(p)
    if re.match(r"^\.env(\..+)?$", name) and not name.endswith(".example"):
        findings.append((p, 0, "tracked-env-file"))
        continue
    if allowed(p) or not os.path.isfile(p):
        continue
    try:
        data = open(p, "rb").read()
    except OSError:
        continue
    if b"\0" in data[:4096]:
        continue
    for i, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        if "secret-scan:allow" in line:
            continue
        for rule, rx in SHAPES:
            if rx.search(line):
                findings.append((p, i, rule))
        m = ASSIGN.search(line)
        if m:
            v = m.group(2)
            # code expressions (member access such as `meta.api_key.get_value`, SCREAMING_SNAKE names) and obvious placeholders are not secrets
            looks_like_ref = bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+", v)) or bool(re.fullmatch(r"[A-Za-z_]+", v)) or v.lower().startswith(("http", "your", "change", "replace"))
            if not looks_like_ref and len(set(v)) > 10 and entropy(v) >= 3.6:
                findings.append((p, i, "high-entropy-secret-assignment"))

for p, i, rule in sorted(set(findings)):
    print(f"{p}:{i}: {rule}")
if findings:
    print(f"scan-secrets: {len(set(findings))} finding(s). Remove the secret (and rotate it), or allow-list a test fixture.", file=sys.stderr)
    sys.exit(1)
print("scan-secrets: clean")
'
