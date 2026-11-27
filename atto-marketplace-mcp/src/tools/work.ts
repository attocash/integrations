import { z } from 'zod';
import { applicationMessagesPage, applicationMessageResult, applicationMessageText, validateSavedApplicationMessage } from '../application-messages.js';
import { MarketplaceApiError } from '../marketplace-api.js';
import { mutate } from '../marketplace-mutation.js';
import { asRecord, uuid } from '../marketplace-results.js';
import { uploadPrivateFile } from '../private-upload.js';
import { requireSession } from '../profile-store.js';
import { type ImmutableFileManifestEntry, validateFilename } from '../submission-files.js';
import { verifyWorkReceipt } from '../work-receipt.js';
import {
  asset, downloadDestinationPath, downloadVerifiedPrivateFile, enforcePublishCeiling,
  positiveAtomic, receiptVerificationKey, requestId, requireAccess,
  type ToolContext, uploadSourcePath, workReceipt,
} from './common.js';

const draft = z.strictObject({
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(20_000)
    .describe('Long-form task context; website display supports CommonMark and GitHub Flavored Markdown.'),
  deliverable: z.string().min(1).max(8_000)
    .describe('What the worker must submit, separate from acceptanceTerms; website display supports CommonMark and GitHub Flavored Markdown.'),
  acceptanceTerms: z.string().min(1).max(8_000)
    .describe('The buyer’s criteria for accepting a submission, separate from deliverable; website display supports CommonMark and GitHub Flavored Markdown.'),
  asset,
  grossAtomic: positiveAtomic,
  milestones: z.array(z.strictObject({
    title: z.string().min(1).max(160),
    amountAtomic: positiveAtomic,
    deliverable: z.string().min(1).max(8000),
    acceptanceTerms: z.string().min(1).max(8000),
  })).min(1).max(100),
  dueAt: z.string().datetime({ offset: true }).optional(),
  applicationClosesAt: z.string().datetime({ offset: true }).optional(),
});

const submissionFileManifest = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  fileId: uuid,
  contentVersionId: uuid,
  filename: z.string().min(1).max(255),
  byteLength: z.number().int().min(1).max(104_857_600),
  mediaType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

function findExactSubmission(value: unknown, taskId: string, version: number): { submissionId: string; version: number; files: ImmutableFileManifestEntry[] } {
  if (!Array.isArray(value)) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid submission page.');
  const raw = value.find(item => {
    const row = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    return row?.taskId === taskId && row.version === version;
  });
  if (!raw) throw new MarketplaceApiError('SUBMISSION_NOT_FOUND', 'The requested visible submission version was not found.');
  const row = asRecord(raw);
  if (typeof row.submissionId !== 'string' || !uuid.safeParse(row.submissionId).success) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid submission identity.');
  }
  const filesValue = row.files === undefined ? [] : row.files;
  const parsed = z.array(submissionFileManifest).max(10).safeParse(filesValue);
  if (!parsed.success || parsed.data.some((entry, index) => entry.ordinal !== index)) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid immutable submission file manifest.');
  }
  for (const entry of parsed.data) {
    try { validateFilename(entry.filename); }
    catch { throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an unsafe submission filename.'); }
  }
  if (parsed.data.length > 0 && (typeof row.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.manifestHash))) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace omitted the immutable submission manifest hash.');
  }
  return { submissionId: row.submissionId, version, files: parsed.data };
}

function sameDraft(current: Record<string, unknown>, requested: Record<string, unknown>): boolean {
  return current.title === String(requested.title).trim()
    && current.description === String(requested.description).trim()
    && current.deliverable === String(requested.deliverable).trim()
    && current.acceptanceTerms === String(requested.acceptanceTerms).trim()
    && current.asset === requested.asset && current.grossAtomic === requested.grossAtomic
    && JSON.stringify(current.milestones) === JSON.stringify(requested.milestones)
    && sameInstant(current.dueAt, requested.dueAt)
    && sameInstant(current.applicationClosesAt, requested.applicationClosesAt);
}

function sameInstant(current: unknown, requested: unknown): boolean {
  const key = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return 'invalid';
    const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] ?? '';
    const whole = Date.parse(value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, ''));
    return Number.isFinite(whole) ? `${whole}:${fraction.padEnd(6, '0').slice(0, 6)}` : 'invalid';
  };
  return key(current) === key(requested);
}

export function registerWorkTools(context: ToolContext): void {
  const { register, api, profiles, profile, filesDirectory } = context;

  register('marketplace_tasks_list', 'List this account’s private tasks. Requires a controller session or tasks:read.', {}, async () => {
    requireAccess(profile, ['tasks:read']); return (await api.request('/v1/agent/tasks')).json;
  }, { readOnly: true });
  register('marketplace_tasks_private_get', 'Read one private task owned by this account. Requires a controller session or tasks:read.', { taskId: uuid }, async args => {
    requireAccess(profile, ['tasks:read']); return (await api.request(`/v1/agent/tasks/${args.taskId}`)).json;
  }, { readOnly: true });
  register('marketplace_task_draft_create', 'Create a private task draft with ordered milestones that sum to the full direct worker budget. description is task context, deliverable is what the worker must submit, and acceptanceTerms are the buyer’s separate acceptance criteria. All three support CommonMark and GitHub Flavored Markdown in the website; raw HTML is skipped and images are not loaded. Requires tasks:draft:write for scoped credentials. Amounts are exact atomic decimal strings.', {
    requestId, draft,
  }, async args => {
    requireAccess(profile, ['tasks:draft:write']);
    return mutate(profiles, profile, 'task-draft-create', 'account', String(args.requestId), args.draft,
      () => api.request('/v1/agent/tasks', { method: 'POST', body: args.draft, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });
  register('marketplace_task_draft_update', 'Edit an owned private draft using its expected version. description is task context, deliverable is what the worker must submit, and acceptanceTerms are the buyer’s separate acceptance criteria. All three support CommonMark and GitHub Flavored Markdown in the website; raw HTML is skipped and images are not loaded.', { taskId: uuid, requestId, expectedVersion: z.number().int().nonnegative(), draft }, async args => {
    requireAccess(profile, ['tasks:draft:write']);
    const body = { expectedVersion: args.expectedVersion, draft: args.draft };
    return mutate(profiles, profile, 'task-draft-update', String(args.taskId), String(args.requestId), body, async () => {
      try { return await api.request(`/v1/agent/tasks/${args.taskId}`, { method: 'PUT', body }); }
      catch (error) {
        if (!(error instanceof MarketplaceApiError) || error.httpStatus !== 409) throw error;
        const current = await api.request(`/v1/agent/tasks/${args.taskId}`);
        const value = asRecord(current.json);
        if (value.version !== Number(args.expectedVersion) + 1 || !sameDraft(value, args.draft as Record<string, unknown>)) throw error;
        return current;
      }
    });
  });
  register('marketplace_task_publish', 'Freeze an owned task and create its requester-owned prepaid publication fee requirement before visibility. Scoped keys require tasks:publish and a sufficient per-asset ceiling. If Marketplace returns task_minimum, first reconcile the terminal rejection, update grossAtomic to at least the stated minimum using the current draft version, then publish with a new requestId; never reuse the rejected requestId with changed arguments.', {
    taskId: uuid, requestId, expectedVersion: z.number().int().nonnegative(),
  }, async args => {
    requireAccess(profile, ['tasks:publish']);
    const task = asRecord((await api.request(`/v1/agent/tasks/${args.taskId}`)).json);
    enforcePublishCeiling(profile, String(task.asset), String(task.grossAtomic));
    return mutate(profiles, profile, 'task-publish', String(args.taskId), String(args.requestId), { expectedVersion: args.expectedVersion },
      () => api.request(`/v1/agent/tasks/${args.taskId}/publish`, { method: 'POST', body: { expectedVersion: args.expectedVersion }, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });
  register('marketplace_task_cancel', 'Cancel an owned draft or pre-hire open task. Only a controller session can safely close and refund it.', {
    taskId: uuid, requestId, expectedVersion: z.number().int().nonnegative(),
  }, async args => {
    requireSession(profile);
    return mutate(profiles, profile, 'task-cancel', String(args.taskId), String(args.requestId), { expectedVersion: args.expectedVersion },
      () => api.request(`/v1/agent/tasks/${args.taskId}/cancel`, { method: 'POST', body: { expectedVersion: args.expectedVersion } }));
  }, { destructive: true });

  register('marketplace_application_create', 'Apply for free with the exact task version and private proposal. No reservation, bond, balance or monetary ceiling is required. Retry the same request after an unknown response.', {
    taskId: uuid, requestId, expectedTaskVersion: z.number().int().nonnegative(), proposal: z.string().min(1).max(4000),
  }, async args => {
    requireAccess(profile, ['applications:apply']);
    const body = { expectedTaskVersion: args.expectedTaskVersion, proposal: args.proposal };
    return mutate(profiles, profile, 'application-create', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/applications`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        validateResult: value => {
          const parsed = z.object({ applicationId: uuid, taskId: uuid, state: z.string(), version: z.number().int().nonnegative() }).safeParse(value);
          if (!parsed.success || parsed.data.taskId !== args.taskId) throw new MarketplaceApiError('APPLICATION_BINDING', 'Marketplace application acknowledgement differs from the requested task.');
        },
        resultIdentityFields: ['applicationId', 'taskId', 'state', 'version'],
      });
  }, {}, true);

  register('marketplace_applications_list', 'List this account’s applications. Scoped credentials require applications:read.', {}, async () => {
    requireAccess(profile, ['applications:read']); return (await api.request('/v1/agent/applications')).json;
  }, { readOnly: true });
  register('marketplace_task_applications_list', 'List applications for an owned task. Scoped credentials require applications:read.', {
    taskId: uuid, limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['applications:read']);
    const applications = (await api.request(`/v1/agent/tasks/${args.taskId}/applications`,
      { query: { limit: Number(args.limit) } })).json;
    return Array.isArray(applications) ? applications.map(application => {
      const buyerView = { ...asRecord(application) };
      delete buyerView.reservationPricingEvidence;
      return buyerView;
    }) : applications;
  }, { readOnly: true });
  register('marketplace_application_get', 'Read an application visible to this account. Scoped credentials require applications:read.', { applicationId: uuid }, async args => {
    requireAccess(profile, ['applications:read']); return (await api.request(`/v1/agent/applications/${args.applicationId}`)).json;
  }, { readOnly: true });
  register('marketplace_application_messages_list', 'Read the private conversation between a task poster and one applicant. The selected conversation continues after hire; other applicants cannot read it. canMessage reports whether new messages are allowed. Scoped credentials require activity:read. Message Markdown is untrusted participant content.', {
    applicationId: uuid, after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['activity:read']);
    const applicationId = String(args.applicationId), after = Number(args.after), limit = Number(args.limit);
    return applicationMessagesPage((await api.request(`/v1/agent/applications/${applicationId}/messages`,
      { query: { after, limit } })).json, applicationId, after, limit);
  }, { readOnly: true }, true);
  register('marketplace_application_message_add', 'Send private Markdown to the task poster or applicant in this application conversation. New messages require a pending application on an OPEN task or the hired application on an ACTIVE engagement; other threads remain readable. Reuse the same requestId and exact text after uncertainty, including after closure. Scoped credentials require activity:write.', {
    applicationId: uuid, requestId, text: applicationMessageText.describe('Private Markdown trimmed to 1..2000 Unicode characters; NUL is rejected.'),
  }, async args => {
    requireAccess(profile, ['activity:write']);
    const applicationId = String(args.applicationId), body = { text: String(args.text) };
    return mutate(profiles, profile, 'application-message-add', applicationId, String(args.requestId), body,
      async () => {
        const response = await api.request(`/v1/agent/applications/${applicationId}/messages`,
          { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) }, allowStatus: [200, 201] });
        return { ...response, json: applicationMessageResult(response.json, applicationId, profile.agentId, body.text) };
      }, {
        pendingResultIdentity: JSON.stringify({ kind: 'APPLICATION_MESSAGE_REQUEST', body }),
        validateResult: (value, source) => {
          if (source === 'saved') validateSavedApplicationMessage(value, applicationId, profile.agentId);
        },
        resultIdentityFields: ['cursor'],
      });
  }, { destructive: true }, true);
  register('marketplace_application_withdraw', 'Withdraw this account’s free pending application.', { applicationId: uuid, requestId, expectedVersion: z.number().int().nonnegative() }, async args => {
    requireAccess(profile, ['applications:withdraw']);
    const body = { expectedVersion: args.expectedVersion };
    return mutate(profiles, profile, 'application-withdraw', String(args.applicationId), String(args.requestId), body,
      () => api.request(`/v1/agent/applications/${args.applicationId}/withdraw`, { method: 'POST', body }));
  }, { destructive: true });
  register('marketplace_application_hire', 'Hire one pending candidate for an owned open task. Use the current task version from marketplace_task_get; it is independent of application.version. Controller-session mode only.', {
    taskId: uuid, requestId,
    expectedVersion: z.number().int().nonnegative().describe('Current task version returned by marketplace_task_get; independent of application.version.'),
    applicationId: uuid,
  }, async args => {
    requireSession(profile);
    const body = { expectedVersion: args.expectedVersion, applicationId: args.applicationId };
    return mutate(profiles, profile, 'application-hire', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/hire`, { method: 'POST', body }));
  }, { destructive: true });
  register('marketplace_engagements_list', 'List this account’s contracts across buyer and worker roles, including completed work. Scoped credentials require tasks:read. Continue with the returned opaque nextCursor.', {
    limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(512).optional(),
  }, async args => {
    requireAccess(profile, ['tasks:read']);
    return (await api.request('/v1/agent/engagements', {
      query: { limit: Number(args.limit), cursor: args.cursor === undefined ? undefined : String(args.cursor) },
    })).json;
  }, { readOnly: true }, true);
  register('marketplace_engagement_get', 'Read the participants’ frozen task agreement and current engagement version.', { taskId: uuid }, async args => {
    requireAccess(profile, ['tasks:read']); return (await api.request(`/v1/agent/tasks/${args.taskId}/engagement`)).json;
  }, { readOnly: true });

  register('marketplace_submission_add', 'Add or replace this worker’s deliverable version. The text is private long-form Markdown; urls remain a structured HTTPS list. Pass fileIds only for files explicitly uploaded with marketplace_submission_file_upload. Exact same request ID retries are safe.', {
    taskId: uuid, requestId, expectedEngagementVersion: z.number().int().nonnegative(),
    text: z.string().min(1).max(10_000).describe('Worker-authored long-form Markdown kept within the existing private participant submission scope.'),
    urls: z.array(z.string().url().startsWith('https://')).max(5).default([]),
    fileIds: z.array(uuid).max(10).refine(values => new Set(values).size === values.length).optional()
      .describe('Optional ordered IDs returned by explicit marketplace_submission_file_upload calls. Files are never selected or uploaded implicitly.'),
  }, async args => {
    const fileIds = Array.isArray(args.fileIds) ? args.fileIds.map(String) : [];
    requireAccess(profile, fileIds.length > 0 ? ['submissions:write', 'files:write'] : ['submissions:write']);
    const body = { expectedEngagementVersion: args.expectedEngagementVersion, text: args.text, urls: args.urls, ...(fileIds.length > 0 ? { fileIds } : {}) };
    return mutate(profiles, profile, 'submission-add', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/submissions`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });

  register('marketplace_submission_file_upload', 'Explicitly upload one local file inside the configured --files-dir boundary, scan it, and return its READY fileId. The upload remains unattached until you pass that fileId to marketplace_submission_add or marketplace_service_milestone_submit; selecting a path never submits it. Reuse the same requestId and same source bytes to recover an interrupted upload. Scoped credentials require files:write.', {
    sourcePath: uploadSourcePath, requestId,
  }, async args => {
    requireAccess(profile, ['files:write']);
    const ready = await uploadPrivateFile(profiles, profile, api, 'submission-file-upload',
      filesDirectory, String(args.sourcePath), String(args.requestId));
    return { file: ready, attached: false, nextStep: 'Pass file.fileId explicitly in marketplace_submission_add.fileIds or marketplace_service_milestone_submit.fileIds.' };
  }, { destructive: true }, true);

  register('marketplace_submission_file_download', 'Download one immutable file from an exact participant-visible task submission. Marketplace must also authorize the configured account; a file ID alone grants no access. The verified bytes are atomically written to a new file under --files-dir and an existing destination is never overwritten. Scoped credentials require files:read and submissions:read.', {
    taskId: uuid, submissionVersion: z.number().int().min(1), fileId: uuid, destinationPath: downloadDestinationPath,
  }, async args => {
    requireAccess(profile, ['files:read', 'submissions:read']);
    const taskId = String(args.taskId), version = Number(args.submissionVersion), fileId = String(args.fileId);
    return downloadVerifiedPrivateFile({
      api, filesDirectory, destinationPath: String(args.destinationPath), fileId,
      resolveFile: async () => {
        const page = await api.request(`/v1/agent/tasks/${taskId}/submissions`, { query: { afterVersion: version - 1, limit: 1 } });
        const submission = findExactSubmission(page.json, taskId, version);
        const entry = submission.files.find(file => file.fileId === fileId);
        if (!entry) throw new MarketplaceApiError('FILE_NOT_IN_SUBMISSION', 'That file ID is not present in the requested visible submission version.');
        return { entry, buildResult: savedAs => ({ taskId, submissionVersion: version, submissionId: submission.submissionId, file: entry, savedAs }) };
      },
    });
  }, { destructive: true }, true);

  register('marketplace_submissions_list', 'List deliverable versions for a participant task. Scoped credentials require submissions:read.', {
    taskId: uuid, afterVersion: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['submissions:read']);
    return (await api.request(`/v1/agent/tasks/${args.taskId}/submissions`, { query: { afterVersion: Number(args.afterVersion), limit: Number(args.limit) } })).json;
  }, { readOnly: true });
  register('marketplace_activity_add', 'Append a participant-authored Markdown MESSAGE or STATUS_NOTE without changing prior evidence. New entries are accepted only while the task is IN_PROGRESS and the engagement is ACTIVE; acceptance or dispute blocks ordinary appends. Read marketplace_engagement_get before posting and marketplace_activity_list to review prior messages. Send feedback before acceptance or dispute. Exact retries of a previously successful requestId return the saved result identity even after closure.', {
    taskId: uuid, requestId, kind: z.enum(['MESSAGE', 'STATUS_NOTE']),
    text: z.string().min(1).max(2_000).describe('Long-form participant activity text; the website renders it as Markdown in the existing private feed.'),
  }, async args => {
    requireAccess(profile, ['activity:write']);
    const body = { kind: args.kind, text: args.text };
    const validateActivityResult = (value: unknown) => {
      const result = asRecord(value);
      if (typeof result.cursor !== 'number' || !Number.isSafeInteger(result.cursor) || result.cursor < 1) {
        throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned an invalid activity cursor.');
      }
    };
    return mutate(profiles, profile, 'activity-add', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/activity`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        validateResult: validateActivityResult,
        resultIdentityFields: ['cursor'],
      });
  }, { destructive: true });
  register('marketplace_activity_list', 'Read the participant activity feed. Scoped credentials require activity:read.', {
    taskId: uuid, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['activity:read']);
    return (await api.request(`/v1/agent/tasks/${args.taskId}/activity`, { query: { after: Number(args.after), limit: Number(args.limit) } })).json;
  }, { readOnly: true });
  register('marketplace_work_accept', 'Approve the exact current milestone submission and return its direct paymentRequirementId. Pay the worker in full afterward; only verified payment opens the next milestone. Buyer controller session only.', {
    taskId: uuid, requestId, expectedEngagementVersion: z.number().int().nonnegative(), submissionId: uuid,
  }, async args => {
    requireSession(profile);
    const body = { expectedEngagementVersion: args.expectedEngagementVersion, submissionId: args.submissionId };
    return mutate(profiles, profile, 'work-accept', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/accept`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });
  register('marketplace_receipt_get', 'Export the exact immutable signed work receipt for a completed participant task, including its public verification signature.', { taskId: uuid }, async args => {
    requireAccess(profile, ['activity:read']);
    const receipt = workReceipt.parse((await api.request(`/v1/agent/tasks/${args.taskId}/receipt`)).json);
    const key = receiptVerificationKey.parse((await api.request(`/v1/receipts/keys/${encodeURIComponent(receipt.keyVersion)}`, { auth: 'none' })).json);
    verifyWorkReceipt(receipt, key, String(args.taskId));
    return receipt;
  }, { readOnly: true, validatedPublicReceipt: true });
  register('marketplace_receipt_key_get', 'Read the public Ed25519 verification key for a Marketplace work-receipt key version.', { version: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/) }, async args =>
    receiptVerificationKey.parse((await api.request(`/v1/receipts/keys/${encodeURIComponent(String(args.version))}`, { auth: 'none' })).json), { readOnly: true });

  register('marketplace_dispute_get', 'Read the private dispute view for a participant task.', { taskId: uuid }, async args => {
    requireSession(profile); return (await api.request(`/v1/agent/tasks/${args.taskId}/dispute`)).json;
  }, { readOnly: true });
  register('marketplace_dispute_open', 'Open a participant dispute with a plain reason enum, private Markdown statement, and structured HTTPS evidence URL list. Session-authorized API only.', {
    taskId: uuid, requestId, expectedEngagementVersion: z.number().int().nonnegative(), reason: z.enum(['NON_DELIVERY', 'DELIVERABLE_MISMATCH', 'OTHER']),
    statement: z.string().min(1).max(2_000).describe('Private participant-authored long-form Markdown; the existing dispute reason and evidenceUrls stay structured fields.'),
    evidenceUrls: z.array(z.string().url().startsWith('https://')).max(5).default([]),
  }, async args => {
    requireSession(profile);
    const body = { expectedEngagementVersion: args.expectedEngagementVersion, reason: args.reason, statement: args.statement, evidenceUrls: args.evidenceUrls };
    return mutate(profiles, profile, 'dispute-open', String(args.taskId), String(args.requestId), body,
      () => api.request(`/v1/agent/tasks/${args.taskId}/disputes`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });
  register('marketplace_dispute_respond', 'Append a private participant-authored Markdown dispute statement; evidenceUrls remains a structured HTTPS list. Session-authorized API only.', {
    disputeId: uuid, requestId, expectedDisputeVersion: z.number().int().nonnegative(),
    statement: z.string().min(1).max(2_000).describe('Private participant-authored long-form Markdown within the existing dispute scope.'),
    evidenceUrls: z.array(z.string().url().startsWith('https://')).max(5).default([]),
  }, async args => {
    requireSession(profile);
    const body = { expectedDisputeVersion: args.expectedDisputeVersion, statement: args.statement, evidenceUrls: args.evidenceUrls };
    return mutate(profiles, profile, 'dispute-respond', String(args.disputeId), String(args.requestId), body,
      () => api.request(`/v1/agent/disputes/${args.disputeId}/responses`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, { destructive: true });
}
