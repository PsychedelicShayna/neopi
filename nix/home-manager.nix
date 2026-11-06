{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omomp;
  toml = pkgs.formats.toml { };
  # Match NeoPi's reversible explicit-clear metadata instead of dropping nulls.
  segment = name: builtins.replaceStrings [ "~" "/" ] [ "~0" "~1" ] name;
  encode = pointer: value:
    if value == null then { value = ""; nullPaths = [ pointer ]; }
    else if builtins.isList value then
      let entries = lib.imap0 (index: item: encode "${pointer}/${toString index}" item) value;
      in {
        value = map (entry: entry.value) entries;
        nullPaths = lib.concatMap (entry: entry.nullPaths) entries;
      }
    else if builtins.isAttrs value then
      let
        entries = lib.mapAttrsToList (name: item: {
          inherit name;
          omitted = item == null;
          result = encode "${pointer}/${segment name}" item;
        }) value;
      in {
        value = builtins.listToAttrs (map (entry: {
          inherit (entry) name;
          value = entry.result.value;
        }) (builtins.filter (entry: !entry.omitted) entries));
        nullPaths = lib.concatMap (entry: entry.result.nullPaths) entries;
      }
    else { inherit value; nullPaths = [ ]; };
  encoded = encode "" cfg.settings;
  document = assert !(cfg.settings ? __npi);
    encoded.value // lib.optionalAttrs (encoded.nullPaths != [ ]) {
      __npi = { version = 1; null_paths = encoded.nullPaths; };
    };
  configFile = toml.generate "omp-config.toml" document;
in
{
  options.programs.omp = {
    enable = lib.mkEnableOption "NeoPi coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.omp.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "NeoPi package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr (lib.types.attrsOf lib.types.anything);
      default = null;
      description = ''
        Settings written declaratively to {file}`~/.omp/agent/config.toml`.
        On each `home-manager switch` the declared settings are copied into
        place as a writable regular file (not a read-only store symlink), so
        NeoPi can acquire its config lock and rewrite the file when persisting
        runtime changes (`/settings`, onboarding). Those runtime changes are
        overwritten by the declared values again on the next
        `home-manager switch`.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # OMP rewrites its config at runtime and acquires an advisory lock on it
    # first; on macOS the lock backend creates an flock sidecar next to the
    # target file. A `home.file` store symlink is read-only and lives under
    # /nix/store, so both the lock and the atomic rewrite fail with EACCES and
    # break every launch. Copy a writable regular file instead. The DAG entry
    # is written literally (rather than via `lib.hm.dag.entryAfter`) so the
    # home-manager-free module evaluation in `flake.nix` keeps working.
    home.activation.omompConfig = lib.mkIf (cfg.settings != null) {
      before = [ ];
      after = [ "writeBoundary" ];
      data = ''
        run mkdir -p "$HOME/.omp/agent"
        run install -m 600 ${configFile} "$HOME/.omp/agent/config.toml"
      '';
    };
  };
}
