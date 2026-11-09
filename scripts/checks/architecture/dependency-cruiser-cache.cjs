const { createHash } = require('node:crypto');
const path = require('node:path');

/** @param {string} root @param {readonly string[]} inputs @returns {string} */
function dependencyCruiserCacheDirectory(root, inputs) {
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(input).update('\0');
  return path.join(
    root,
    'node_modules',
    '.cache',
    'dependency-cruiser',
    hash.digest('hex'),
  );
}

module.exports = { dependencyCruiserCacheDirectory };
