{
  description = "luna-pi dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Node 26 for node:sqlite; pnpm self-switches to the packageManager pin.
          packages = [
            pkgs.nodejs_26
            pkgs.pnpm
            pkgs.sqlite
          ];
        };
      });
    };
}
