#!/bin/bash
# Several crawl steps in one go: run.sh "launch|com.apple.Maps" "snap|maps-root" "pair|v-maps-x|Search|find a place" ...
# Each step is "cmd|a|b|c|d"; see sim.mjs for the commands.
here="$(cd "$(dirname "$0")" && pwd)"
sim() { node "$here/sim.mjs" "$@"; }
export WAIT=${WAIT:-2500}
for step in "$@"; do
  IFS='|' read -r cmd a b c d <<< "$step"
  case "$cmd" in
    pair) out=$(sim pair "$a" "$b" "$c" "$d" 2>&1); echo "$out" | head -1; echo "$out" | grep -E "Heading|BackButton" | head -3 | sed 's/^/    /';;
    snap) sim snap "$a" "$b" 2>&1 | head -1;;
    show) sim ax 2>&1 | grep -v "Dynamic Island\|'Cellular'\|battery power\|:[0-9][0-9] [AP]M'";;
    back) sim tap "#BackButton" fresh 2>&1 | head -1; sleep 2;;
    swipe) sim swipe "$a" $b; sleep 1.5;;
    launch) sim launch "$a" >/dev/null; sleep ${b:-3};;
    terminate) sim terminate "$a" >/dev/null;;
    home) sim home >/dev/null; sleep 2;;
    tap) sim tap "$a" fresh 2>&1 | head -1; sleep ${b:-2};;
    tapxy) sim ax >/dev/null; sim tapxy "$a" "$b"; sleep ${c:-2};;
    type) sim type "$a" >/dev/null; sleep 1;;
    url) sim url "$a" >/dev/null; sleep ${b:-3};;
    wait) sleep "$a";;
    *) echo "?? $cmd";;
  esac
done
