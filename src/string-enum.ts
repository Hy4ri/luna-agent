import { Type, type TSchemaOptions } from "typebox";

/**
 * A string parameter limited to `values`, as JSON Schema `enum`. Prefer it to a union of literals: that union is an
 * `anyOf` of consts, and validation then names only the first option (`expected "running"`), so a model that sent a
 * near miss (`"failed"`) cannot see the valid values. `enum` reports all of them, and codemode still renders `"a" | "b"`.
 */
export function StringEnum<const T extends readonly [string, ...string[]]>(values: T, options?: TSchemaOptions) {
  return Type.Unsafe<T[number]>({ ...options, type: "string", enum: [...values] });
}
