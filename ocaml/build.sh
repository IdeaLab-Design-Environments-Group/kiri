#!/bin/sh
# Compile the footprint generator and regenerate src/model/footprints.generated.ts.
#
# The architecture dance is not superstition. `ocamlopt` emits code for the machine it was built for,
# and hands the result to `cc` to assemble. On an Apple Silicon Mac a shell running under Rosetta
# reports i386, so `cc` assembles for x86 and chokes on arm64 output with a screenful of "unknown
# token in expression". Re-exec under the architecture ocamlopt is actually targeting.
set -e
cd "$(dirname "$0")"

run=""
if [ "$(uname -s)" = "Darwin" ]; then
  want=$(ocamlopt -config | awk '/^architecture:/ { print $2 }')
  [ "$want" = "amd64" ] && want=x86_64
  if [ -n "$want" ] && [ "$(arch)" != "$want" ] && command -v arch >/dev/null 2>&1; then
    run="arch -$want"
  fi
fi

$run ocamlfind ocamlopt kicad.ml footprints.ml -o footprints

# Two modules out of one scan: the parts a rail can take, which the app imports directly, and the rest,
# which the palette pulls in on demand. See the header of ocaml/footprints.ml for why they are apart.
#
# Each goes through a temp file: a generator that redirects onto its own committed output destroys it
# the moment the run fails, which is the worst possible time to lose it. And each is moved only after
# BOTH have been written, so a failure halfway cannot leave the two halves out of step with each other
# — a stale eager half beside a fresh lazy one would silently duplicate or drop parts.
trap 'rm -f footprints.tmp.ts footprints.rest.tmp.ts' EXIT
$run ./footprints > footprints.tmp.ts
$run ./footprints rest > footprints.rest.tmp.ts
mv footprints.tmp.ts ../src/model/footprints.generated.ts
mv footprints.rest.tmp.ts ../src/model/footprints.rest.generated.ts
