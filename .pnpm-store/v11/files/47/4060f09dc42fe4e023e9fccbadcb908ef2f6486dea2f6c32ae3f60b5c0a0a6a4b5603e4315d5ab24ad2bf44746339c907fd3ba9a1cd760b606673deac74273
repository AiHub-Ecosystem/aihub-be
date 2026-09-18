import { Response, ResponseDefinition } from 'postman-collection';
import { SyncOptions } from '../../shared';
/**
 * Merges a single response from target with a corresponding response from current.
 * Returns the merged response definition.
 * @param {Response} targetResponse - Response from the target request
 * @param {Response } sourceResponse - Response from the source request
 * @param {SyncOptions} syncOptions - Options to control what should be synced
 * @param {boolean} preserveOriginalRequest - When true (and example syncing is enabled), keep the
 *   existing response's `originalRequest` request-side data (body, url query/path variables and
 *   headers) instead of overwriting it with the spec's request. The spec carries a single live
 *   request (body + parameter values) that maps to the first saved response; set this for every
 *   response after the first so a request/parameter change in the spec doesn't overwrite every
 *   response's originalRequest. Defaults to false (first response takes the spec request).
 * @returns {ResponseDefinition} Merged response definition
 */
export declare function mergeResponseData(targetResponse: Response, sourceResponse: Response, syncOptions: SyncOptions, preserveOriginalRequest?: boolean): ResponseDefinition;
//# sourceMappingURL=ResponseMerger.d.ts.map