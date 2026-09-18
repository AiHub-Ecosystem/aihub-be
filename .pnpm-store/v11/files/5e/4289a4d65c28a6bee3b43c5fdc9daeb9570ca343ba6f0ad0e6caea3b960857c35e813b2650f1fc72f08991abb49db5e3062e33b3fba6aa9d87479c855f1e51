/**
 * General utility functions shared across SpecificationCollection modules
 */
import { Item } from 'postman-collection';
/**
 * Get the request identifier (method + path) for an item.
 * @param {Item} item - The item to get the identifier for.
 * @returns {string} The request identifier (method + path)
 */
export declare function getRequestIdentifier(item: Item): string;
/**
 * Recursively clones a fragment of the specification while removing any
 * vendor-extension keys (those starting with "x-") and the OpenAPI `default` key.
 * This is used solely for equality comparisons so that differences due to `default` and vendor extensions
 * do not cause `$ref` expansion or unnecessary diffs.
 *
 * @param {unknown} node - The fragment (object/array/primitive) from which keys should be stripped.
 * @returns {unknown} A deep clone of the fragment with all `x-*` and `default` keys removed.
 * Primitive values are returned unchanged.
 */
export declare function stripVendorExtensions(node: unknown): unknown;
/**
 * Checks if an object contains a $ref property.
 * @param {unknown} obj The object to check.
 * @returns {boolean} True if the object contains a $ref property at the top level, otherwise false.
 */
export declare function isRef(obj: unknown): obj is {
    $ref: string;
};
/**
 * Determines whether two fragments are deeply equal after removing all
 * vendor-extensions (`x-*` keys).
 *
 * @param {unknown} firstFragment - First fragment to compare.
 * @param {unknown} secondFragment - Second fragment to compare.
 * @returns {boolean} `true` if the fragments are equal once vendor extensions are ignored, otherwise `false`.
 */
export declare function isEqualAfterIgnoringVendorExtensions(firstFragment: unknown, secondFragment: unknown): boolean;
/**
 * Deep merge function that preserves vendor extensions at all levels
 * and ignores the `default` key from `latest` as per the rules:
 * - If `current` has a `default`, it is preserved.
 * - If `current` does not have `default`, it is removed from the merged result even if present in `latest`.
 * @param {unknown} latest - The latest object (source of truth for standard properties)
 * @param {unknown} current - The current object (source for vendor extensions)
 * @returns {unknown} Merged object with vendor extensions preserved at all levels
 */
export declare function deepMergeWithVendorExtensions(latest: unknown, current: unknown): unknown;
/**
 * Wraps bare (unquoted) Postman variables — e.g. the `{{customer_id}}` in `{ "id": {{customer_id}} }`
 * — in a sentinel-marked string so the body becomes valid JSON and can be parsed and merged. Variables
 * that already sit inside a JSON string (e.g. `"Bearer {{token}}"`) are left untouched because they are
 * already valid JSON. A JSON-string scanner is used (instead of a regex) so that `{{...}}` occurrences
 * inside string literals are correctly ignored, including strings containing escaped quotes. For example,
 * in `{ "note": "value is \"{{x}}\"", "id": {{x}} }` only the second (bare) `{{x}}` is wrapped; the first
 * one is left untouched because it sits inside a string whose escaped quotes do not end the string early.
 * @param {string} raw - Raw body which may contain bare Postman variables
 * @returns {string} A JSON-parseable body with bare variables sentinel-wrapped
 */
export declare function protectBarePostmanVariables(raw: string): string;
/**
 * Restores bare Postman variables that were sentinel-wrapped by {@link protectBarePostmanVariables},
 * turning `"\uE000{{customer_id}}\uE000"` in the serialized JSON back into a bare `{{customer_id}}`.
 * @param {string} raw - Serialized JSON possibly containing sentinel-wrapped variables
 * @returns {string} Body with bare variables restored to their original unquoted form
 */
export declare function restoreBarePostmanVariables(raw: string): string;
//# sourceMappingURL=utils.d.ts.map