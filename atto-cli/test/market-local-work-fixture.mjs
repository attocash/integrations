// Disposable loopback-only LOCAL proof-of-work endpoint for the MKT-081 real-MCP test.
import { createServer } from 'node:http';
import { AttoInstant, AttoNetwork, AttoWork } from '@attocash/commons-core';

export async function startLocalAttoWorkServer(port = 0) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/works') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2048) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body?.network !== 'LOCAL' || !Number.isSafeInteger(body.timestamp)
        || typeof body.target !== 'string' || !/^[a-f0-9]{64}$/i.test(body.target)) {
        response.writeHead(400).end();
        return;
      }
      const block = {
        network: AttoNetwork.LOCAL,
        timestamp: AttoInstant.Companion.fromEpochMilliseconds(BigInt(body.timestamp)),
        y2h: () => ({ s2q_1: new Int8Array(Buffer.from(body.target, 'hex')) }),
      };
      for (let nonce = 0; nonce < 1_000_000; nonce++) {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setUint32(0, nonce, true);
        const work = new AttoWork(new Int8Array(bytes.buffer));
        if (work.isValid(block)) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ work: work.toString() }));
          return;
        }
        if (nonce % 1000 === 999) await new Promise(resolve => setImmediate(resolve));
      }
      response.writeHead(503).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL work fixture did not bind.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
