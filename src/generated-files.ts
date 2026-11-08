// Persistent outputs that do not belong to a project. Never change the session cwd to this directory.
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

export const GENERATED_FILE_TYPES = ["images", "documents", "html", "data", "audio", "video", "other"] as const;
export type GeneratedFileType = typeof GENERATED_FILE_TYPES[number];

export const generatedRoot = (dataDir: string) => join(dataDir, "generated");

/** Worker paths must use the worker's namespace, not the daemon host's path rules or home. */
export function workerGeneratedRoot(home: string, platform: string): string {
  const paths = platform === "win32" ? win32 : posix;
  if (!home || !paths.isAbsolute(home)) throw new Error("The execution worker's home directory is unavailable.");
  return paths.join(home, ".luna", "generated");
}

export function generatedDirectories(root: string, platform: string = process.platform): Record<GeneratedFileType, string> {
  const paths = platform === "win32" ? win32 : posix;
  return Object.fromEntries(GENERATED_FILE_TYPES.map(type => [type, paths.join(root, type)])) as Record<GeneratedFileType, string>;
}

/** Called on the owning machine. Existing files are never moved or removed. */
export function ensureGeneratedDirectories(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const dir of Object.values(generatedDirectories(root))) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Worker image delivery uses an exclusive private write, unlike a generic ExecutionEnv.writeFile. */
export async function saveGeneratedImage(root: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  ensureGeneratedDirectories(root);
  const path = join(generatedDirectories(root).images, `${crypto.randomUUID()}.png`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600, signal });
  return path;
}

export function generatedFilesInstructions(root: string, platform: string = process.platform): string {
  const directories = generatedDirectories(root, platform);
  return [
    `Save persistent generated files unrelated to a project under ${JSON.stringify(root)} on this execution machine.`,
    ...GENERATED_FILE_TYPES.map(type => `${type}: ${JSON.stringify(directories[type])}`),
    "Use images for pictures; documents for PDF, Word, text, and Markdown; html for standalone pages; data for CSV, JSON, YAML, and spreadsheets; audio/video for media; other for archives and unknown types.",
    "Use descriptive filenames with a unique suffix. Do not overwrite unrelated results. Keep an HTML page and its required assets together under html/<unique-name>/.",
    "Project source, tests, documentation, and required assets stay in their correct project directories. An explicitly requested destination takes precedence.",
    "Keep the session working directory unchanged. Use absolute output paths for write tools and shell generators. Temporary processing files belong in temporary storage, not here.",
    "Return the saved absolute path, and use MEDIA: for downloadable results. Never fall back to a project directory when generated storage is unavailable.",
    "Do not move existing files or delete generated outputs without a separate request.",
  ].join("\n");
}
