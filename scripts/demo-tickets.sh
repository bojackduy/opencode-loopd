#!/bin/bash
# Recorded with: asciinema rec --command "bash scripts/demo-tickets.sh" assets/loopd-tickets.cast
cd /Users/duytrinh/Code/opencode-loopd
PS1='$ '

say() { echo; echo "### $1"; sleep 1; }
run() { echo "\$ $1"; sleep 0.6; eval "$1"; sleep 1; }

say "loopd ticket-per-scope: live demo (real plugin, real store)"
run "opencode plugin list 2>/dev/null | grep -i loopd"
say "parallel disjoint writes + overlap queue + crash sweep"
run "bun run scripts/demo-tickets.mjs"
say "trace: every grant/queue hits the flow log"
run "grep -o '\"event\":\"ticket\.[a-z.]*\"' /tmp/loopd-server.log | sort | uniq -c | tail -5"
echo; echo "### full log: tail -f /tmp/loopd-server.log"
sleep 2
