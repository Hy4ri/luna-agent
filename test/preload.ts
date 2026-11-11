// Tests must never touch host services. Point the external CLIs at a binary
// that exits non-zero; tests that need a fake CLI set their own path.
process.env.LUNA_OPENCODE_EXECUTABLE ??= "/bin/false";
process.env.LUNA_CLAUDE_EXECUTABLE ??= "/bin/false";
