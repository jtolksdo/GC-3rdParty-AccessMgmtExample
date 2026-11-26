#!/usr/bin/env bash
# Secret scan before every commit (this repository is public).
#   ops/secret-scan.sh            scan the working tree (all files tracked by git)
#   ops/secret-scan.sh --staged   scan only what is staged (pre-commit hook)
# Install the hook:  ln -sf ../../ops/secret-scan-hook.sh .git/hooks/pre-commit
set -uo pipefail
mode="${1:-tree}"
if [ "$mode" = "--staged" ]; then files=$(git diff --cached --name-only --diff-filter=ACMR); else files=$(git ls-files); fi
[ -z "$files" ] && exit 0
bad=0
# Local runtime files: real e-mails, org ids, audit logs - never public.
forbidden='(^|/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|.*\.har|data/users\.txt|data/flight-recorder\.log|data/sessions\.enc(\.tmp)?|config/config\.json|genesys/agents\.json)$'
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if [[ "$f" =~ $forbidden ]]; then echo "FORBIDDEN FILE: $f"; bad=1; continue; fi
  case "$f" in *.jpg|*.png|*.ico) continue;; esac
  content=$( [ "$mode" = "--staged" ] && git show ":$f" 2>/dev/null || cat "$f" )
  hit=$(printf '%s' "$content" | grep -n -E \
    -e 'sk-[A-Za-z0-9_-]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
    -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e '(client_secret|clientSecret)["'"'"' ]*[:=][ ]*["'"'"'][A-Za-z0-9_-]{20,}' 2>/dev/null | head -3)
  # Real-looking e-mail addresses (placeholders and well-known no-reply addresses are fine)
  hit2=$(printf '%s' "$content" | grep -n -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
    | grep -v -i -E '@(example\.(com|org|net)|your-org\.example|anthropic\.com|users\.noreply\.github\.com)' | head -3)
  if [ -n "$hit" ] || [ -n "$hit2" ]; then
    echo "POSSIBLE SECRET OR PERSONAL DATA in $f:"
    printf '%s\n%s\n' "$hit" "$hit2" | sed '/^$/d' | cut -c1-120 | sed 's/^/   /'
    bad=1
  fi
done <<< "$files"
if [ $bad -ne 0 ]; then echo "Aborted: remove secrets / personal data before committing." >&2; exit 1; fi
echo "Secret scan ok ($(printf '%s\n' "$files" | wc -l | tr -d ' ') files)."
