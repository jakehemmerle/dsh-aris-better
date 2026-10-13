# Nix environment for dsh-aris-better (aris-2cs.3).
#
# Inputs are locked to the same pins Jake's nix-config deploys with:
#   - nixpkgs = nix-config's nixpkgs-tools rev (NixOS/nixpkgs @ b6c8664...),
#     whose beads is 1.3.0 (overridden to the 1.3.1 release below, exactly like
#     nix-config pkgs/beads.nix) and whose playwright-driver is 1.63.0, the
#     same version as dsh/test's committed playwright-core, so
#     playwright-driver.browsers carries the exact chromium-1243 the suite
#     resolves through PLAYWRIGHT_BROWSERS_PATH.
#   - nix-dsh = nix-config's nix-dsh rev (f0ca0d7...), which builds
#     dsh-0.2.1-alpha.2 -- the release target of the aris-2cs epic.
# nix/dsh-tui-package-lock.json is vendored from nix-config
# pkgs/dsh-tui/package-lock.json (nix-config 31d1097, file added in 141aadd);
# the npm tarball ships no lockfile, and that one was generated exactly for the
# manifest this flake edits (see dshTuiSrc below). dsh-TUI here is upstream
# 0.14.0 without nix-config desktop patches -- the rig only mounts the
# package dir (DSH_TUI_DIR) and dsh launches it, so no patched launch surface
# is needed.
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/b6c8664de9b6cc07fe5666a29f91884ba81197c4";
    nix-dsh = {
      url = "github:jakehemmerle/nix-dsh/f0ca0d745df8cbe99bad91d59153dbd690ae6660";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nix-dsh }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      # The unlisted TUI peers as one JSON array string: runCommand environment
      # attributes must be strings, and jq --argjson needs real JSON text.
      unlistedPeersJson = "[\"@deepseek-ai/cordis-plugin-include\",\"@deepseek-ai/dsh-agent-preset\",\"@deepseek-ai/dsh-attachment-local\",\"@deepseek-ai/dsh-mcp-client\",\"@deepseek-ai/dsh-session-persistence\",\"@deepseek-ai/dsh-session-persistence-jsonl\"]";
      forAllSystems = nixpkgs.lib.genAttrs systems;
      version = (nixpkgs.lib.importJSON ./package.json).version;

      # The dsh-TUI npm tarball ships no lockfile and bundles @dsh-std /
      # @dsh-tui-vendor in node_modules; npm ci would empty node_modules, so
      # the bundled packages are parked and restored postInstall. The
      # installed manifest keeps the published peers plus the unlisted ones
      # (dsh routes a linked package's imports to its own copies only for
      # names listed there) -- the same edit nix-config pkgs/dsh-tui.nix
      # makes, and the state nix/dsh-tui-package-lock.json was generated for.
      dshTuiSrc = pkgs: pkgs.runCommand "dsh-tui-source-0.14.0"
        {
          nativeBuildInputs = [ pkgs.jq ];
          inherit unlistedPeersJson;
        } ''
        mkdir -p $out
        tar -xzf ${pkgs.fetchurl {
          url = "https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.14.0.tgz";
          hash = "sha512-syU0CLbAoxA97URyhnPFiLbWm3dXrmCR5NCO6mFovRi7mebX2HeEYdhpugEoT9vZ1vpUfE/+uX7xrs6zOGUJ1g==";
        }} -C $out --strip-components=1
        jq --argjson names "$unlistedPeersJson" "
          .peerDependencies += (\$names | map({ key: ., value: \"*\" }) | from_entries)
          | .peerDependenciesMeta += (\$names | map({ key: ., value: { optional: true } }) | from_entries)" \
          $out/package.json > $out/package.json.runtime
        jq "del(.devDependencies, .scripts, .bundledDependencies, .peerDependencies, .peerDependenciesMeta)
          | .optionalDependencies |= with_entries(select(.key | startswith(\"@dsh-\") | not))" \
          $out/package.json.runtime > $out/package.json
        mv $out/node_modules $out/bundled
        cp ${./nix/dsh-tui-package-lock.json} $out/package-lock.json
      '';

      # The test-only npm deps (fast-check, playwright-core), fetched from the
      # committed dsh/test manifests; the checks install them into dsh/test.
      testDepsSrc = pkgs: pkgs.runCommand "dsh-test-deps-src" { } ''
        mkdir -p $out
        cp ${./dsh/test/package.json} $out/package.json
        cp ${./dsh/test/package-lock.json} $out/package-lock.json
      '';
      testNpmDeps = pkgs: pkgs.fetchNpmDeps {
        name = "dsh-aris-test-npm-deps";
        src = testDepsSrc pkgs;
        hash = "sha256-uyG2ee01aoW5uyONuomDNsbNvNoItZPdGNDz3B0mc0I=";
      };
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dsh = nix-dsh.packages.${system}.dsh;
        in rec {
          default = dsh-aris-better;

          # The plugin bundle itself: plain ESM and Markdown, byte-identical to
          # the checkout except that dsh/test (test-only) is not shipped --
          # same recipe as nix-config pkgs/dsh-aris.nix, from this flake src.
          dsh-aris-better = pkgs.stdenvNoCC.mkDerivation {
            pname = "dsh-aris-better";
            inherit version;
            src = self;

            dontConfigure = true;
            dontBuild = true;
            dontFixup = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp -r dsh skills tools templates mcp-servers package.json LICENSE README.md $out/
              rm -r $out/dsh/test
              runHook postInstall
            '';

            meta = {
              description = "ARIS research workflow as a DeepSeek Harness agent preset with a cross-family reviewer";
              homepage = "https://github.com/jakehemmerle/dsh-aris-better";
              license = nixpkgs.lib.licenses.mit;
            };
          };

          dsh-tui = pkgs.buildNpmPackage {
            pname = "dsh-tui";
            version = "0.14.0";
            src = dshTuiSrc pkgs;

            npmDepsHash = "sha256-r/+rfdxNEAuaJ3Dy+Bc7wLmhN2GlTpbwDQc7awTKG7A=";
            npmFlags = [ "--legacy-peer-deps" "--ignore-scripts" ];
            dontNpmBuild = true;

            postInstall = ''
              pkg=$out/lib/node_modules/@deepseek-harness-tui/dsh-tui
              cp -r bundled/. $pkg/node_modules/
              cp package.json.runtime $pkg/package.json
              # The launchers bootstrap and self-update a mutable profile; the
              # rig mounts the package dir via DSH_TUI_DIR instead, so no bin
              # is exposed (nothing here may ever touch ~/.dsh or ~/.dsh-tui).
              rm -r $out/bin
            '';

            meta = {
              description = "Terminal user interface for DeepSeek Harness (upstream 0.14.0, unpatched)";
              homepage = "https://github.com/ccch1mneyyy/dsh-TUI";
              license = nixpkgs.lib.licenses.mit;
            };
          };

          # Latest upstream beads on the nixpkgs expression, wrapped with the
          # dolt bd shells out to -- nix-config pkgs/beads.nix override.
          beads = (pkgs.beads.override { dolt = pkgs.dolt; }).overrideAttrs (finalAttrs: _: {
            version = "1.3.1";
            src = pkgs.fetchFromGitHub {
              owner = "gastownhall";
              repo = "beads";
              tag = "v${finalAttrs.version}";
              hash = "sha256-k3WUy0FWPoO7Ymu+FFgS2yYZ4u10Fb7mPBYqs17IP2U=";
            };
            vendorHash = "sha256-mnQo3S7JLrx0nY5EIP3qQVqWLTlisYhjJFzqgPD/xu8=";
            # The ~1500-test cmd/bd suite runs for up to 25 minutes per
            # platform; the same suite passed for nixpkgs release.
            doCheck = false;
          });

          # A self-contained copy of the checkout with the test deps installed:
          # the e2e app cds into it, so nix run .#e2e works from anywhere.
          e2e-runner = pkgs.buildNpmPackage {
            pname = "dsh-aris-better-e2e";
            inherit version;
            src = self;
            npmRoot = "dsh/test";
            npmDeps = testNpmDeps pkgs;
            dontNpmBuild = true;

            installPhase = ''
              mkdir -p $out
              cp -r . $out/repo
              chmod -R u+w $out/repo
            '';
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dsh = nix-dsh.packages.${system}.dsh;
          dshTui = self.packages.${system}.dsh-tui;
        in {
          default = pkgs.mkShell {
            # node + tmux for the suites and the rig; pinned dsh 0.2.1-alpha.2
            # and dsh-TUI 0.14.0 as the real-client targets; beads 1.3.1 for
            # the work graph; the playwright browsers matching the committed
            # playwright-core 1.63.0.
            packages = [
              pkgs.nodejs
              pkgs.tmux
              dsh
              dshTui
              self.packages.${system}.beads
              pkgs.playwright-driver.browsers
            ];
            shellHook = ''
              export DSH_BIN=${dsh}/bin/dsh
              export DSH_ROOT=${dsh}/lib/node_modules/@deepseek-ai/dsh
              export DSH_TUI_DIR=${dshTui}/lib/node_modules/@deepseek-harness-tui/dsh-tui
              export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
              echo "dsh-aris-better dev shell: node $(node --version), bd $(bd --version 2>/dev/null | awk \"{print $3}\")"
            '';
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dsh = nix-dsh.packages.${system}.dsh;
        in {
          # The fast suite (unit seams + rig web lifecycle, mock model only)
          # against the pinned dsh, in a throwaway HOME, no network.
          fast-suite = pkgs.buildNpmPackage {
            pname = "dsh-aris-better-fast-suite";
            inherit version;
            src = self;
            npmRoot = "dsh/test";
            npmDeps = testNpmDeps pkgs;
            dontNpmBuild = true;
            doCheck = true;

            nativeBuildInputs = [ dsh ];

            checkPhase = ''
              runHook preCheck
              export DSH_BIN=${dsh}/bin/dsh
              export DSH_ROOT=${dsh}/lib/node_modules/@deepseek-ai/dsh
              export HOME=$TMPDIR/home
              mkdir -p $HOME
              export FC_SEED=''${FC_SEED:-20261012}
              # The fast (dependency-free) suites only: the real-client e2e
              # suites — Playwright against real dsh web and the dsh-TUI
              # inertness property — run through `apps.e2e` with the Nix
              # Chromium and dsh-TUI 0.14.0, never inside this check.
              node --test $(ls dsh/test/*.test.mjs | grep -v '[.]e2e[.]test[.]mjs')
              runHook postCheck
            '';

            installPhase = ''
              mkdir -p $out
              echo "fast-suite green (dsh 0.2.1-alpha.2, seed ''${FC_SEED:-20261012})" > $out/result.txt
            '';
          };
        });

      apps = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          dsh = nix-dsh.packages.${system}.dsh;
          dshTui = self.packages.${system}.dsh-tui;
        in {
          # Real-client suites (Playwright web properties + dsh-TUI
          # inertness) against the pinned dsh + dsh-TUI, mock model only,
          # throwaway HOME/DSH_HOME, port 0, private tmux sockets.
          #   nix run .#e2e                        (seed 20261012)
          #   FC_SEED=<seed> nix run .#e2e         (replay any recorded seed)
          e2e = {
            type = "app";
            program = "${pkgs.writeShellApplication {
              name = "dsh-aris-e2e";
              runtimeInputs = [ pkgs.nodejs pkgs.tmux ];
              text = ''
                set -euo pipefail
                cd ${self.packages.${system}.e2e-runner}/repo
                e2eHome=$(mktemp -d)
                export HOME="$e2eHome"
                export DSH_BIN=${dsh}/bin/dsh
                export DSH_ROOT=${dsh}/lib/node_modules/@deepseek-ai/dsh
                export DSH_TUI_DIR=${dshTui}/lib/node_modules/@deepseek-harness-tui/dsh-tui
                export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
                export FC_SEED=''${FC_SEED:-20261012}
                exec node --test dsh/test/*.e2e.test.mjs
              '';
            }}";
          };
        });
    };
}
