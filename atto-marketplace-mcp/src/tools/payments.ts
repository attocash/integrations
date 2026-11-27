import { z } from 'zod';
import { payRequirement, paymentRequirement, reauthorizeRelay, relayDeadline } from '../direct-payments.js';
import { mutate } from '../marketplace-mutation.js';
import { uuid } from '../marketplace-results.js';
import { requestId, requireAccess, type ToolContext } from './common.js';

export function registerPaymentTools(context: ToolContext): void {
  const { register, api, profiles, profile, walletEnv, nanoWork } = context;

  register('marketplace_publication_fee_get', 'Read the original own-service publication fee, earned portion and durable unused-fee refund obligation/status/hash. Network or liquidity failure leaves the owed refund visible; no customer withdrawal exists.', { feeId: uuid }, async args => {
    requireAccess(profile, ['payments:read']);
    return (await api.request(`/v1/agent/publication-fees/${args.feeId}`)).json;
  }, { readOnly: true }, true);
  register('marketplace_payment_get', 'Read exact immutable payment instructions, independent verification status, and the admitted relay’s hash, status, reason and next check time when available.', { paymentId: uuid }, async args => {
    requireAccess(profile, ['payments:read']);
    return paymentRequirement((await api.request(`/v1/agent/payments/${args.paymentId}`)).json, String(args.paymentId), profile.accountId);
  }, { readOnly: true }, true);
  register('marketplace_payment_pay', 'Pay this immutable requirement using the selected wallet’s external-transfer grant and spending limits. The wallet signs and saves one native SEND. Marketplace retries queued durable relays with the same SEND. Retry the same paymentId after uncertainty and use marketplace_payment_get to check progress. VERIFIED means independently confirmed and paid.', { paymentId: uuid }, async args => {
    requireAccess(profile, ['payments:read', 'payments:write']);
    return payRequirement({ api, profile, env: walletEnv, paymentId: String(args.paymentId), nanoWork });
  }, {}, true);
  register('marketplace_payment_relay_reauthorize', 'With explicit payer approval for this deadline, allow Marketplace to relay the same previously signed Nano x402 publication fee. Use the original requestId and transactionHash from marketplace_payment_get when relay.authorizationRequired is true. validUntil must be an exact UTC deadline within five minutes. Retry with identical arguments after uncertainty. Read payment status for independent verification.', {
    paymentId: uuid, requestId, transactionHash: z.string().regex(/^[a-fA-F0-9]{64}$/), validUntil: relayDeadline,
  }, async args => {
    requireAccess(profile, ['payments:read', 'payments:write']);
    return reauthorizeRelay({
      api, profile, env: walletEnv, paymentId: String(args.paymentId), requestId: String(args.requestId),
      transactionHash: String(args.transactionHash), validUntil: String(args.validUntil),
    });
  }, {}, true);
  register('marketplace_payment_evidence', 'Report the native SEND hash for a payment already broadcast by your wallet. Marketplace independently checks the transfer against this requirement. Retry with the same requestId and transactionHash.', {
    paymentId: uuid, requestId, transactionHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }, async args => {
    requireAccess(profile, ['payments:write']);
    return (await api.request(`/v1/agent/payments/${args.paymentId}/evidence`, { method: 'POST', body: { requestId: args.requestId, transactionHash: args.transactionHash } })).json;
  }, {}, true);
  register('marketplace_task_milestone_refund', 'Prepare a voluntary full direct refund of a verified paid milestone from its worker to its original buyer. This creates refundPaymentRequirementId; sign locally and relay with marketplace_payment_pay. Paid history, earned fee and milestone order remain unchanged.', { taskId: uuid, milestoneId: uuid, requestId }, async args => {
    requireAccess(profile, ['payments:write']);
    const body = { requestId: args.requestId };
    return mutate(profiles, profile, 'task-milestone-refund', String(args.milestoneId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/milestones/${args.milestoneId}/refund`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, {}, true);
  register('marketplace_task_milestones', 'Read ordered milestones with exact approvals, immutable direct payment requirements, and verified transaction hashes. Only verified paid milestones open the next one.', { taskId: uuid }, async args => {
    requireAccess(profile, ['submissions:read']);
    return (await api.request(`/v1/agent/tasks/${args.taskId}/milestones`)).json;
  }, { readOnly: true }, true);
}
