"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeResponseData = mergeResponseData;
const BodyMerger_1 = require("./BodyMerger");
const HeaderMerger_1 = require("./HeaderMerger");
const RequestMerger_1 = require("./RequestMerger");
const header_1 = require("../header");
/**
 * Preserve an existing saved response's header PARAMETER values while keeping any
 * implicit/generated headers (e.g. Content-Type, Accept) produced from the spec. Used when
 * preserving a non-first response's originalRequest on multi-example sync: for a shared key the
 * spec-generated header metadata (name casing, description, schema-derived flags) is kept and only
 * the existing header's `value`/`disabled` are copied over; generated target-only headers are
 * retained, and header params that only exist on the source are appended.
 *
 * Header keys are matched case-insensitively (HTTP header names are case-insensitive).
 * @param {HeaderDefinition[] | undefined} targetHeaders - Spec-generated headers (base)
 * @param {HeaderDefinition[] | undefined} sourceHeaders - Existing saved response headers to preserve
 * @returns {HeaderDefinition[] | undefined} Merged header list
 */
function preserveHeaderParams(targetHeaders, sourceHeaders) {
    if (!Array.isArray(sourceHeaders)) {
        return targetHeaders;
    }
    const result = Array.isArray(targetHeaders) ? [...targetHeaders] : [], indexByLowerKey = new Map();
    result.forEach((header, index) => {
        if (typeof header?.key === 'string') {
            indexByLowerKey.set(header.key.toLowerCase(), index);
        }
    });
    sourceHeaders.forEach((sourceHeader) => {
        if (typeof sourceHeader?.key !== 'string') {
            return;
        }
        const lowerKey = sourceHeader.key.toLowerCase();
        if (indexByLowerKey.has(lowerKey)) {
            // Keep the spec-generated header (name casing + metadata); copy only the existing header's
            // value/disabled state onto it.
            const index = indexByLowerKey.get(lowerKey);
            result[index] = { ...result[index], value: sourceHeader.value, disabled: sourceHeader.disabled };
        }
        else {
            indexByLowerKey.set(lowerKey, result.length);
            result.push(sourceHeader);
        }
    });
    return result;
}
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
function mergeResponseData(targetResponse, sourceResponse, syncOptions, preserveOriginalRequest = false) {
    const targetRes = targetResponse.toJSON(), sourceRes = sourceResponse.toJSON(), shouldSyncExamples = syncOptions?.syncExamples;
    if (targetRes?.originalRequest && sourceRes?.originalRequest) {
        targetRes.originalRequest = (0, RequestMerger_1.mergeRequestData)(targetRes.originalRequest, sourceRes.originalRequest, syncOptions);
        /*
         * The spec carries a single live request (its body plus the primary parameter values), which
         * maps to the first saved response. For the remaining responses, preserve their existing
         * request-side data — body, url (query params + path variables) and headers — so that editing
         * the request or a parameter in the spec doesn't overwrite every response's originalRequest on
         * sync-back. Each component is deleted when the source had none, mirroring the body rule.
         * Only applies when example syncing is enabled (the multi-example flow).
         */
        if (preserveOriginalRequest && shouldSyncExamples) {
            // Cast for the delete-when-source-had-none branches (url/body are not always optional in the type).
            const targetOriginalRequest = targetRes.originalRequest;
            // Body: preserve the existing example's body wholesale (delete when the source had none).
            if (sourceRes.originalRequest.body === undefined) {
                delete targetOriginalRequest.body;
            }
            else {
                targetRes.originalRequest.body = sourceRes.originalRequest.body;
            }
            // URL: preserve the existing example's url (query params + path variable values) wholesale.
            if (sourceRes.originalRequest.url === undefined) {
                delete targetOriginalRequest.url;
            }
            else {
                targetRes.originalRequest.url = sourceRes.originalRequest.url;
            }
            // Headers: preserve the existing example's header PARAMETER values while keeping any
            // implicit/generated headers (e.g. Content-Type, Accept) the spec produced.
            targetRes.originalRequest.header = preserveHeaderParams(targetRes.originalRequest.header, sourceRes.originalRequest.header);
        }
    }
    // Attach implicit headers from the source response to the target response
    // if they are not present in the target response
    // Required because the response body and implicit headers are not generated
    // during collection to spec conversion for non json responses.
    (0, header_1.attachImplicitHeaders)(sourceRes.header, targetRes.header);
    if (targetRes?.header) {
        targetRes.header = shouldSyncExamples ?
            targetRes.header :
            (0, HeaderMerger_1.mergeRequestAndResponseHeaders)(targetRes.header, sourceRes.header);
    }
    targetRes.body = shouldSyncExamples ? targetRes.body : (0, BodyMerger_1.mergeRequestAndResponseBodyRaw)(targetRes.body, sourceRes.body);
    return targetRes;
}
//# sourceMappingURL=ResponseMerger.js.map