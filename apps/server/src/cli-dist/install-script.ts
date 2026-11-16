/** Origins are scheme://host[:port] with punycoded hosts; anything else is refused rather than escaped. */
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/**
 * POSIX sh installer for the asm CLI. The origin is embedded single-quoted after validation, so it can never
 * break out of the string. `\${` escapes shell expansions inside this template literal.
 */
export function renderInstallScript(origin: string): string {
  if (!SAFE_ORIGIN.test(origin)) throw new Error('public origin contains characters not allowed in install.sh');
  return `#!/bin/sh
# Installs the asm CLI from ${origin}
#   curl -fsSL ${origin}/cli/install.sh | sh
# Target: \${ASM_INSTALL_DIR:-$HOME/.local/bin}/asm. Needs Node.js >= 22 and curl or wget. Never uses sudo.
set -eu

ASM_URL='${origin}'
INSTALL_DIR="\${ASM_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf 'asm install: %s\\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js >= 22 is required, but 'node' was not found in PATH."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 is required (found $(node --version 2>/dev/null || echo unknown))."

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is required."
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is required."
fi

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t asm)
PART=''
cleanup() { rm -rf "$TMP_DIR"; if [ -n "$PART" ]; then rm -f "$PART"; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fetch "$ASM_URL/cli/asm.json" "$TMP_DIR/asm.json" || die "download failed: $ASM_URL/cli/asm.json"
fetch "$ASM_URL/cli/asm.mjs" "$TMP_DIR/asm.mjs" || die "download failed: $ASM_URL/cli/asm.mjs"

field() {
  node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(m[process.argv[2]] ?? ""))' \\
    "$TMP_DIR/asm.json" "$1" || die "invalid manifest asm.json"
}
VERSION=$(field version)
SHA256=$(field sha256)
SIZE=$(field size)

[ "$(wc -c < "$TMP_DIR/asm.mjs" | tr -d ' ')" = "$SIZE" ] || die "size mismatch for asm.mjs (expected $SIZE bytes); aborting."
[ "$(sha256 "$TMP_DIR/asm.mjs")" = "$SHA256" ] || die "SHA-256 mismatch for asm.mjs; aborting."

mkdir -p "$INSTALL_DIR"
PART="$INSTALL_DIR/.asm.$$.tmp"
cp "$TMP_DIR/asm.mjs" "$PART"
chmod 755 "$PART"
mv -f "$PART" "$INSTALL_DIR/asm"
PART=''

printf 'Installed asm %s to %s\\n' "$VERSION" "$INSTALL_DIR/asm"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\\n%s is not on your PATH. Add it, e.g. in ~/.profile:\\n  export PATH="%s:$PATH"\\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac
printf '\\nNext step:\\n  asm login %s\\n' "$ASM_URL"
`;
}
