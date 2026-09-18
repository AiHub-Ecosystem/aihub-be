"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncCollection = syncCollection;
const postman_collection_1 = require("postman-collection");
const auth_1 = require("./auth");
const collection_1 = require("./collection");
const merge_1 = require("./merge");
const path_1 = require("./path");
const shared_1 = require("../shared");
const lodash_1 = __importDefault(require("lodash"));
/**
 * Update the implicit headers from the current collection if the latest collection does not have the implicit headers.
 * @param {HeaderList} initial - The headers from the current collection
 * @param {HeaderList} final - The headers from the latest collection
 */
function attachImplicitHeaders(initial, final) {
    const implicitHeaders = ['Accept', 'Content-Type'];
    initial.each((header) => {
        if (header.key && implicitHeaders.includes(header.key) && !final.has(header.key)) {
            final.add(new postman_collection_1.Header(header.toJSON()));
        }
    });
}
/**
 * Syncs the state between two item groups / Collections.
 *
 * Warning: This mutates the current collection
 * @param {ItemGroup} latestCollectionState - The item group to be synced.
 * @param {ItemGroup} currentCollectionState - The current item group.
 * @param {SyncOptions} options - Options to control what should be synced.
 */
function syncCollection(latestCollectionState, currentCollectionState, options) {
    const mergedOptions = { ...shared_1.DEFAULT_SYNC_OPTIONS, ...(options ?? {}) };
    // Sync the state of the collection to be synced with the current collection
    latestCollectionState.items.each((item) => {
        if (item instanceof postman_collection_1.ItemGroup) {
            // Recursively sync the state of the folder
            const currentFolder = (0, collection_1.findFolderItemByName)(currentCollectionState, item.name);
            if (currentFolder) {
                syncCollection(item, currentFolder, mergedOptions);
            }
            else {
                currentCollectionState.items.add(item);
            }
            return;
        }
        const path = (0, shared_1.getRequestIdentifier)(item), currentRequest = (0, collection_1.findRequestItemByPathAndMethod)(currentCollectionState, path);
        if (currentRequest) {
            attachImplicitHeaders(currentRequest.request.headers, item.request.headers);
            const existingRequestAuth = lodash_1.default.cloneDeep(currentRequest.request?.auth?.toJSON?.()) ?? {}, currentRequestPath = currentRequest.request.url.path, latestRequestPath = item.request.url.path, variablesToAdd = (0, path_1.extractPostmanVariablesFromPathComponents)(latestRequestPath || [], currentRequestPath || []), 
            // Preserve current request data before update
            currentRequestJSON = currentRequest.request.toJSON(), latestRequestJSON = item.request.toJSON(), mergedRequestJSON = (0, merge_1.mergeRequestData)(latestRequestJSON, currentRequestJSON, mergedOptions);
            currentRequest.request.update(mergedRequestJSON);
            currentRequest.request.url.variables.assimilate(variablesToAdd, false);
            currentRequest.name = item.name;
            currentRequest.request.name = item.request.name;
            currentRequest.request.description = item.request.description;
            const mergedRequestAuth = (0, auth_1.mergeAuth)(item.request.auth?.toJSON?.() ?? {}, existingRequestAuth), authToApply = (0, auth_1.mergeAuthParams)(mergedRequestAuth, existingRequestAuth);
            if (!authToApply) {
                // No auth to apply, skip
            }
            else if (currentRequest.request.auth && authToApply.params) {
                const paramsArray = authToApply.params.all().map((v) => {
                    return { key: v.key ?? '', value: v.value };
                });
                currentRequest.request.auth.use(authToApply.type, paramsArray);
            }
            else {
                currentRequest.request.authorizeUsing(authToApply.type, authToApply.params);
            }
            const currentResponsesByCode = {};
            // Index existing responses by status code into a per-code queue, preserving order, so multiple
            // saved responses sharing a status code each get their own slot instead of collapsing into one.
            currentRequest.responses.each((response) => {
                if (!currentResponsesByCode[response.code]) {
                    currentResponsesByCode[response.code] = [];
                }
                currentResponsesByCode[response.code].push(response);
            });
            // The spec carries a single live request (body + primary parameter values). It is applied to the
            // originalRequest of only the first response processed overall (isFirstSyncedResponse); every
            // subsequent response preserves its existing originalRequest request-side data — body, url
            // (query/path) and headers (see mergeResponseData) — so a request/parameter change in the spec
            // updates just that first response rather than every response's originalRequest.
            let isFirstSyncedResponse = true;
            item.responses.each((response) => {
                // Pair each incoming response with the next unconsumed existing response of the same code.
                // This is positional pairing used as a fallback: Postman saved responses don't carry a stable
                // identity back from the spec example (same-code responses can even share a name), so we can't
                // reliably key the match. Order is the best deterministic mapping for the generate -> edit -> sync
                // round-trip. Extra incoming examples are added; surplus existing responses are left untouched.
                const matchingResponse = currentResponsesByCode[response.code]?.shift();
                if (matchingResponse) {
                    const mergedResponseData = (0, merge_1.mergeResponseData)(response, matchingResponse, mergedOptions, !isFirstSyncedResponse);
                    matchingResponse.update(mergedResponseData);
                    // SDK converts _postman_previewlanguage to { _: { postman_previewlanguage: '' } }
                    // during response construction.
                    const previewLanguage = response._postman_previewlanguage ??
                        response._?.postman_previewlanguage;
                    matchingResponse._postman_previewlanguage = previewLanguage;
                    if (matchingResponse._?.postman_previewlanguage !== undefined) {
                        delete matchingResponse._.postman_previewlanguage;
                    }
                    matchingResponse.name = response.name;
                }
                else {
                    currentRequest.responses.add(response.toJSON());
                    // SDK converts _postman_previewlanguage during Response construction
                    const addedResponse = currentRequest.responses.one(response.id);
                    if (addedResponse) {
                        const addedPreviewLanguage = response._postman_previewlanguage ??
                            response._?.postman_previewlanguage;
                        addedResponse._postman_previewlanguage = addedPreviewLanguage;
                        if (addedResponse._?.postman_previewlanguage !== undefined) {
                            delete addedResponse._.postman_previewlanguage;
                        }
                    }
                }
                isFirstSyncedResponse = false;
            });
        }
        else {
            currentCollectionState.items.add(item);
        }
    });
    // When opted in, remove orphans: requests and folders that exist in the collection but no longer
    // exist in the latest spec-derived state. Matched folders are pruned recursively above via the
    // sync loop (mergedOptions is propagated), so here we only drop unmatched items at this level.
    if (mergedOptions.deleteOrphanedRequests) {
        currentCollectionState.items.remove((item) => {
            if (item instanceof postman_collection_1.ItemGroup) {
                return !(0, collection_1.findFolderItemByName)(latestCollectionState, item.name);
            }
            return !(0, collection_1.findRequestItemByPathAndMethod)(latestCollectionState, (0, shared_1.getRequestIdentifier)(item));
        }, currentCollectionState);
    }
    currentCollectionState.description = latestCollectionState.description;
    const existingCollectionAuth = lodash_1.default.cloneDeep(currentCollectionState?.auth?.toJSON()) ?? {}, mergedCollectionAuth = (0, auth_1.mergeAuth)(latestCollectionState?.auth?.toJSON() ?? {}, existingCollectionAuth), collectionAuthToApply = (0, auth_1.mergeAuthParams)(mergedCollectionAuth, existingCollectionAuth);
    if (!collectionAuthToApply) {
        // No collection auth to apply, skip
    }
    else if (currentCollectionState.auth && collectionAuthToApply.params) {
        const paramsArray = collectionAuthToApply.params.all().map((v) => {
            return { key: v.key ?? '', value: v.value };
        });
        currentCollectionState.auth.use(collectionAuthToApply.type, paramsArray);
    }
    else {
        currentCollectionState.authorizeRequestsUsing(collectionAuthToApply.type, collectionAuthToApply.params);
    }
    if (latestCollectionState instanceof postman_collection_1.Collection && currentCollectionState instanceof postman_collection_1.Collection) {
        const latestCollectionBaseUrlVar = latestCollectionState.variables.one('baseUrl'), currentCollectionBaseUrlVar = currentCollectionState.variables.one('baseUrl');
        if (latestCollectionBaseUrlVar) {
            if (currentCollectionBaseUrlVar) {
                currentCollectionBaseUrlVar.value = latestCollectionBaseUrlVar.value;
            }
            else {
                currentCollectionState.variables.add(new postman_collection_1.Variable({
                    key: 'baseUrl',
                    value: latestCollectionBaseUrlVar.value
                }));
            }
        }
    }
    return currentCollectionState;
}
//# sourceMappingURL=index.js.map