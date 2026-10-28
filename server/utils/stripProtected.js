// @ts-check

/**
 * Copy of `data` without the fields its owner may not write.
 *
 * Matched on the key's root, so a dotted path is caught too: these payloads go
 * straight into a Mongo `$set`, where `{"rating.average": 5}` or
 * `{"stats.followers": 1000000}` writes the nested value just as well as the
 * whole object would - and a plain `delete safe.rating` never sees it.
 *
 * @param {Record<string, any>} data
 * @param {string[]} protectedFields
 * @returns {Record<string, any>}
 */
function stripProtected(data, protectedFields) {
    const blocked = new Set(protectedFields);
    /** @type {Record<string, any>} */
    const safe = {};
    for (const [key, value] of Object.entries(data || {})) {
        if (!blocked.has(key.split('.')[0])) safe[key] = value;
    }
    return safe;
}

module.exports = { stripProtected };
