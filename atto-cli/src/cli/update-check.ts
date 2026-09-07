import { refreshUpdateCache } from './updates.js';

// Bound the entire worker lifetime as well as the HTTP request, including any
// sockets left open by the HTTP client. This never runs in the wallet process.
setTimeout(() => process.exit(0), 5000).unref();
try {
  const file = process.argv[2];
  if (file) await refreshUpdateCache(file);
} finally {
  process.exit(0);
}
