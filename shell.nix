{ pkgs ? import <nixpkgs> {} }:

let
  electron = pkgs.electron;
in
pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs
    electron
  ];

  shellHook = ''
    # Use the NixOS-patched Electron binary instead of the npm-bundled one.
    # The npm 'electron' package checks this env var and uses it as the
    # electron dist path, avoiding all FHS/sandbox/GPU issues on NixOS.
    export ELECTRON_OVERRIDE_DIST_PATH="${electron}/bin"

    echo ""
    echo "🖥️  ECA Desktop dev shell"
    echo "   Node:     $(node --version)"
    echo "   Electron: $(electron --version)"
    echo ""
    echo "   nix-shell --run 'npm start'  — single command run"
    echo "   npm run dev                  — dev mode (hot-reload)"
    echo "   npm run build                — build for production"
    echo "   npm start                    — run production build"
    echo ""
  '';
}

# Single-command usage:
#   nix-shell --run "npm start"
#   nix-shell --run "npm run dev"
