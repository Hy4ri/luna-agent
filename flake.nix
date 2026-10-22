{
  description = "luna-pi dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f (import nixpkgs {
        system = s;
        overlays = [ rust-overlay.overlays.default ];
      }));
    in
    {
      devShells = forAll (pkgs:
        let
          # Host target plus the Android targets for `cargo tauri android build`.
          rust = pkgs.rust-bin.stable.latest.default.override {
            extensions = [ "rustfmt" "clippy" ];
            targets = [
              "aarch64-linux-android"
              "armv7-linux-androideabi"
              "i686-linux-android"
              "x86_64-linux-android"
            ];
          };
          # Tauri's Android tooling calls rustup. Nix already provides every target, so answer from the sysroot.
          rustup-shim = pkgs.writeShellScriptBin "rustup" ''
            case "$*" in
              "target list --installed"*) ls "$(rustc --print sysroot)/lib/rustlib" | grep -- - ;;
              "target add"*) ;;
              *) echo "rustup shim: unsupported: $*" >&2; exit 1 ;;
            esac
          '';
        in {
        default = pkgs.mkShell {
          # Node 26 for node:sqlite; pnpm self-switches to the packageManager pin.
          packages = [
            pkgs.nodejs_26
            pkgs.pnpm
            pkgs.sqlite
            # Tauri desktop shell (src-tauri). Host cargo is too old, so Rust comes from here.
            rust
            pkgs.pkg-config
            pkgs.jdk17
            pkgs.cargo-tauri
            rustup-shim
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.libsoup_3
            pkgs.gtk3
            pkgs.librsvg
            pkgs.openssl
            pkgs.libayatana-appindicator
          ];
          shellHook = ''
            # Android SDK and NDK are installed outside Nix (see #31); only the paths are set here.
            export JAVA_HOME="${pkgs.jdk17}"
            export ANDROID_HOME="''${ANDROID_HOME:-$HOME/Android/Sdk}"
            export ANDROID_SDK_ROOT="$ANDROID_HOME"
            export NDK_HOME="''${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)}"
          '' + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            # The tray library loads appindicator with dlopen at run time.
            export LD_LIBRARY_PATH="${pkgs.libayatana-appindicator}/lib:$LD_LIBRARY_PATH"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
          '';
        };
      });
    };
}
