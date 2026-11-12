# Vendored libghostty-vt

Both the browser and agent terminal use the official `ghostty-vt-1.0.1-small.wasm` (845,526 bytes), not ghostty-web's private ABI.

- Source: https://release.files.ghostty.org/libghostty-vt/1.0.1/ghostty-vt-1.0.1-small.wasm
- SHA256: `e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01`
- Minisign public key: `RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`
- Signature: `ghostty-vt-1.0.1-small.wasm.minisig`, alongside the binary.

Verified against the official release's signed SHA256SUMS and the binary's detached signature on 2026-11-12, including each trusted-comment signature. To verify locally with minisign:

```sh
minisign -Vm src/terminal/ghostty-vt-1.0.1-small.wasm -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
sha256sum src/terminal/ghostty-vt-1.0.1-small.wasm
```

The Bun loader enforces the checksum before compiling. The browser fetches Vite's content-hashed asset from the same app origin, with no CDN fallback. Update the binary, signature, loader URL, shared checksum, browser asset import, and this document together.

ABI constants/layouts come from the official `vt-1.0.0` headers; 1.0.1 is a compatible patch release. Source: https://github.com/ghostty-org/ghostty/tree/vt-1.0.0/include/ghostty/vt

libghostty-vt is distributed under MIT. Upstream license: https://github.com/ghostty-org/ghostty/blob/vt-1.0.1/LICENSE
