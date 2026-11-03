/** Persisted icon IDs shared by the API and web UI. Null means the default folder icon. */
export const PROJECT_ICONS = ["folder", "code", "terminal", "globe", "smartphone", "layers", "database", "book-open", "briefcase", "flask-conical", "rocket", "wrench"] as const;
export type ProjectIcon = typeof PROJECT_ICONS[number];
export type ProjectAppearance = { color?: string | null; icon?: ProjectIcon | null };
