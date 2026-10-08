#!/usr/bin/env bash
# Managed by CodexSkills bootstrap-code-quality.py
set -euo pipefail
cd "$(dirname "$0")/.."
npx --yes fallow@2.89.0 audit --base "${QUALITY_BASE_REF:-main}" --gate new-only
