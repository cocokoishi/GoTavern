#!/usr/bin/env bash
# Fail when a commit in the pushed range carries an identity that is not part of this project.
#
# WHY THIS EXISTS. Twice now a subagent committed with `noreply@anthropic.com` (git config -c, or the
# GIT_AUTHOR_* environment), which GitHub renders as an outside account on the public contributors list.
# The fix is not another history rewrite: it is a gate that makes the recurrence red on the push that
# introduces it, while the commit is still local and cheap to amend.
#
# An allowlist rather than a denylist, because a denylist only names the mistake that has already happened.
set -eu
range="${1:-}"
if [ -z "${range}" ]; then
  if [ -n "${GITHUB_EVENT_BEFORE:-}" ] && git cat-file -e "${GITHUB_EVENT_BEFORE}^{commit}" 2>/dev/null; then
    range="${GITHUB_EVENT_BEFORE}..HEAD"
  else
    range="-20..HEAD"
  fi
fi

allowed='108864988\+cocokoishi@users.noreply.github.com|glados@aperturescience.invalid|datamaid@example.invalid|sd-comfy@local|consolidation@example.invalid|e2c-batch2@example.invalid'
bad=0
while IFS=$'\t' read -r sha author_email committer_email subject; do
  for email in "${author_email}" "${committer_email}"; do
    if ! printf '%s\n' "${email}" | grep -qxE "${allowed}"; then
      echo "commit ${sha} carries ${email}: ${subject}" >&2
      bad=1
    fi
  done
done < <(git log --format='%h%x09%ae%x09%ce%x09%s' "${range}")

if [ "${bad}" -ne 0 ]; then
  echo "" >&2
  echo "The identity on a commit is part of the public record. Set it from the project's own configuration" >&2
  echo "(git config user.name / user.email, already set in this repository) and do not pass -c user.*" >&2
  echo "or GIT_AUTHOR_*/GIT_COMMITTER_* when committing." >&2
  exit 1
fi
echo "commit identities are all project identities across ${range}"