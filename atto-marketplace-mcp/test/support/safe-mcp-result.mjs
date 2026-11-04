const sensitiveKeys = new Set([
  'mnemonic', 'privatekey', 'seed', 'accesstoken', 'refreshtoken', 'apikey',
  'paymentsignature', 'transactionjson', 'signedpayload', 'signature',
]);

function sensitivePaths(value, path, allowedPaths, matches) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => sensitivePaths(item, `${path}[${index}]`, allowedPaths, matches));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (sensitiveKeys.has(key.toLowerCase()) && !allowedPaths.has(itemPath)) matches.push(itemPath);
    sensitivePaths(item, itemPath, allowedPaths, matches);
  }
}

/** Reject secrets and signed payment material without mistaking a public chain signature for a secret. */
export function assertSafeMcpResult(value, label, allowedPublicPaths = []) {
  const matches = [];
  sensitivePaths(value, '', new Set(allowedPublicPaths), matches);
  if (matches.length) throw new Error(`${label} exposed prohibited field path(s): ${matches.join(', ')}.`);
}
