import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const { MarketplaceApiClient }=await import(pathToFileURL(join(packageDirectory,'dist/marketplace-api.js')).href);

test('signer authority and availability responses preserve their distinct safe public contracts', async () => {
  // Given a pinned profile and responses containing private upstream diagnostics.
  let response;
  const http = createServer((_req, res) => {
    res.writeHead(response.status, {'content-type': 'application/json'});
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const profile = {id:'agent', origin:`http://127.0.0.1:${http.address().port}`, authMode:'scoped-api-key',
    apiKey:'private-credential-must-not-leak'};
  const api = new MarketplaceApiClient({getProfile:() => profile}, 'agent');
  try {
    for (const scenario of [
      {status:403, serverCode:'signer_request_rejected', expected:'SIGNER_REQUEST_REJECTED'},
      {status:503, serverCode:'signer_unavailable', expected:'SIGNER_UNAVAILABLE'},
      {status:403, serverCode:'signer_unavailable', expected:'AUTHORIZATION_DENIED'},
      {status:503, serverCode:'signer_request_rejected', expected:'MARKETPLACE_HTTP'},
      {status:403, serverCode:'other_error', expected:'AUTHORIZATION_DENIED'},
    ]) {
      response = {status:scenario.status, body:{error:scenario.serverCode,
        message:'private-upstream-diagnostic', details:{proof:'private-proof'}}};
      // When the API returns an exact signer status/code pair or a mismatched pair.
      const error = await api.request('/v1/agent/withdrawals', {method:'POST', body:{}}).catch(error => error);
      // Then only recognized pairs retain their typed public contract without diagnostics.
      assert.equal(error.code, scenario.expected);
      assert.equal(error.httpStatus, scenario.status);
      assert.doesNotMatch(JSON.stringify({message:error.message, details:error.details}), /private-/);
      if (scenario.expected.startsWith('SIGNER_')) assert.equal(error.details.serverCode, scenario.serverCode);
    }
  } finally {
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  }
});
