import { z } from 'zod';
import { MarketplaceApiError } from '../marketplace-api.js';
import { mutate } from '../marketplace-mutation.js';
import { asRecord, catalogQuery, indicativePrice, parseMarketplaceDto, uuid } from '../marketplace-results.js';
import { uploadPrivateFile } from '../private-upload.js';
import { productPaidContent, productPurchaseResult, productReceipt, productSellerOrder, verifyProductReceipt } from '../product-purchase.js';
import { ProfileError } from '../profile-error.js';
import {
  asset, downloadDestinationPath, downloadVerifiedPrivateFile, enforceProductPublishCeiling,
  pageLimit, positiveAtomic, receiptVerificationKey, requestId, requireAccess,
  type ToolContext, uploadSourcePath,
} from './common.js';

const safeProductFilename = z.string().min(1).max(510).refine(value => Array.from(value).length <= 255
  && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(value));
const productMarkdown = (maximum: number, minimum = 0) => z.string().max(maximum * 2)
  .refine(value => Array.from(value).length >= minimum && Array.from(value).length <= maximum && !value.includes('\0'));

const publicSellerProfile = z.strictObject({
  agentId: uuid,
  handle: z.string().min(3).max(30).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: productMarkdown(60, 1),
  bio: z.string().max(500).nullable(),
  capabilities: z.array(z.string().min(1).max(40)).max(12),
  createdAt: z.string().datetime({ offset: true }),
  links: z.array(z.strictObject({
    kind: z.enum(['WEBSITE', 'GITHUB']),
    url: z.string().url().max(2048),
    status: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED']),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
  })).max(2),
});

const publicProductFile = z.strictObject({
  fileId: uuid,
  filename: safeProductFilename,
  byteLength: z.number().int().min(1).max(104_857_600),
  mediaType: z.string().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
});

const productPublicProjection = z.strictObject({
  productId: uuid,
  releaseId: uuid,
  releaseSequence: z.number().int().positive(),
  releaseHash: z.string().regex(/^[0-9a-f]{64}$/),
  sellerAgentId: uuid,
  sellerProfile: publicSellerProfile.nullable(),
  title: productMarkdown(160, 1),
  summaryMarkdown: productMarkdown(20_000, 1),
  asset,
  priceAtomic: positiveAtomic,
  indicativePrice: indicativePrice.optional(),
  licenseText: productMarkdown(8_000, 1),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(publicProductFile).max(10).refine(files => new Set(files.map(file => file.fileId)).size === files.length
    && files.reduce((sum, file) => sum + file.byteLength, 0) <= 262_144_000),
});

const productPublicPage = z.strictObject({
  items: z.array(productPublicProjection).max(100),
  nextCursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).nullable(),
});

const productFileManifest = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  fileId: uuid,
  contentVersionId: uuid,
  filename: safeProductFilename,
  byteLength: z.number().int().min(1).max(104_857_600),
  mediaType: z.string().min(1).max(255).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const productDraftContent = {
  title: productMarkdown(160, 1),
  summaryMarkdown: productMarkdown(20_000, 1),
  paidMarkdown: productMarkdown(20_000).nullable(),
  licenseText: productMarkdown(8_000, 1),
  asset,
  priceAtomic: positiveAtomic,
  fileIds: z.array(uuid).max(10).refine(values => new Set(values).size === values.length),
};

const sellerProductDraft = z.strictObject({
  version: z.number().int().nonnegative(),
  ...productDraftContent,
  files: z.array(productFileManifest).max(10).refine(files => files.every((file, index) => file.ordinal === index)
    && new Set(files.map(file => file.fileId)).size === files.length && files.reduce((sum, file) => sum + file.byteLength, 0) <= 262_144_000),
});

const sellerProductRelease = z.strictObject({
  releaseId: uuid,
  releaseSequence: z.number().int().positive(),
  sourceDraftVersion: z.number().int().nonnegative(),
  releaseHash: z.string().regex(/^[0-9a-f]{64}$/),
  feeRateBasisPoints: z.number().int().min(0).max(10_000),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  title: productMarkdown(160, 1),
  summaryMarkdown: productMarkdown(20_000, 1),
  paidMarkdown: productMarkdown(20_000).nullable(),
  licenseText: productMarkdown(8_000, 1),
  asset,
  priceAtomic: positiveAtomic,
  files: z.array(productFileManifest).max(10).refine(files => files.every((file, index) => file.ordinal === index)
    && new Set(files.map(file => file.fileId)).size === files.length && files.reduce((sum, file) => sum + file.byteLength, 0) <= 262_144_000),
  publishedAt: z.string().datetime({ offset: true }),
});

const sellerProductListItem = z.strictObject({
  productId: uuid,
  sellerAgentId: uuid,
  draftVersion: z.number().int().nonnegative(),
  title: productMarkdown(160, 1),
  asset,
  priceAtomic: positiveAtomic,
  published: z.boolean(),
  currentReleaseId: uuid.nullable(),
  currentReleaseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const productPublication = z.object({
  publicationId: uuid, productId: uuid, releaseId: uuid, feeId: uuid,
  paymentRequirementId: uuid.nullable(), state: z.string(),
  quantity: z.number().int().positive(), sold: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(), sellerAddress: z.string(), priceAtomic: positiveAtomic,
});

const sellerProductDetail = z.strictObject({
  productId: uuid,
  sellerAgentId: uuid,
  published: z.boolean(),
  currentReleaseId: uuid.nullable(),
  currentReleaseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  draft: sellerProductDraft,
  releases: z.array(sellerProductRelease).max(100),
  publication: productPublication.nullable(),
  nextReleaseBeforeSequence: z.number().int().positive().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).refine(value => value.draft.files.length === value.draft.fileIds.length
  && value.draft.files.every((file, index) => file.fileId === value.draft.fileIds[index]));

const productMutationResponse = z.strictObject({
  productId: uuid,
  draftVersion: z.number().int().nonnegative(),
  published: z.boolean(),
  releaseId: uuid.nullable(),
  releaseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  publication: productPublication.nullable(),
}).refine(value => (value.releaseId === null) === (value.releaseHash === null));

const productMutationIdentityFields = ['productId', 'draftVersion', 'published', 'releaseId', 'releaseHash', 'publication'];

function validateProductMutation(value: unknown, expectedProductId?: string): void {
  const result = productMutationResponse.safeParse(value);
  if (!result.success || (expectedProductId !== undefined && result.data.productId !== expectedProductId)) {
    throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a product mutation result for a different product or outside the current contract.');
  }
}

export function registerShopTools(context: ToolContext): void {
  const { register, api, profiles, profile, filesDirectory } = context;

  register('marketplace_products_search', 'Search the currently published public Shop catalog by asset and text. Returns only public summaries, seller profiles, exact current release and price, license, and file metadata; paid Markdown, file bytes, and purchase data are never public. Cursors are bound to the filters; clear the cursor after changing them.', {
    limit: pageLimit, cursor: z.string().min(1).max(512).optional(), asset: asset.optional(),
    q: catalogQuery.optional(),
  }, async args => parseMarketplaceDto(productPublicPage, (await api.request('/v1/products', { auth: 'none', query: args as Record<string, string | number | undefined> })).json, 'public product page'),
  { readOnly: true }, true);
  register('marketplace_product_get', 'Read one currently published public Shop product by canonical product ID. Public output excludes paid Markdown, private releases, order data, and storage locators.', {
    productId: uuid,
  }, async args => parseMarketplaceDto(productPublicProjection, (await api.request(`/v1/products/${String(args.productId)}`, { auth: 'none' })).json, 'public product'),
  { readOnly: true }, true);

  register('marketplace_purchases_list', 'List this account’s historical purchases. Scoped credentials require purchases:read.', {}, async () => {
    requireAccess(profile, ['purchases:read']);
    return parseMarketplaceDto(z.array(productPurchaseResult).max(100),
      (await api.request('/v1/agent/purchases')).json, 'buyer purchases');
  }, { readOnly: true }, true);
  register('marketplace_purchase_get', 'Read one purchase as its buyer or seller, including immutable payment and voluntary refund requirement IDs. Scoped credentials require purchases:read.', { purchaseId: uuid }, async args => {
    requireAccess(profile, ['purchases:read']);
    return parseMarketplaceDto(productPurchaseResult,
      (await api.request(`/v1/agent/purchases/${String(args.purchaseId)}`)).json, 'purchase');
  }, { readOnly: true }, true);
  register('marketplace_product_orders_list', 'List orders for this account’s product. Scoped credentials require products:read.', { productId: uuid }, async args => {
    requireAccess(profile, ['products:read']);
    return parseMarketplaceDto(z.array(productSellerOrder).max(100),
      (await api.request(`/v1/agent/products/${String(args.productId)}/orders`)).json, 'seller orders');
  }, { readOnly: true }, true);
  register('marketplace_purchase_content_get', 'Read paid Markdown and the immutable file manifest for an active purchase by this buyer. Refunded orders retain receipts but lose paid content. Scoped credentials require purchases:read.', { purchaseId: uuid }, async args => {
    requireAccess(profile, ['purchases:read']);
    const purchaseId = String(args.purchaseId);
    const result = parseMarketplaceDto(productPaidContent,
      (await api.request(`/v1/agent/purchases/${purchaseId}/content`)).json, 'paid purchase content');
    if (result.purchaseId !== purchaseId) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned another purchase’s content.');
    return result;
  }, { readOnly: true }, true);
  register('marketplace_purchase_receipt_get', 'Export and cryptographically verify a signed purchase or refund receipt against its historical order and Marketplace’s published key. Scoped credentials require purchases:read.', { purchaseId: uuid, kind: z.enum(['PURCHASE', 'REFUND']) }, async args => {
    requireAccess(profile, ['purchases:read']);
    const purchaseId = String(args.purchaseId), kind = String(args.kind);
    const purchase = parseMarketplaceDto(productPurchaseResult,
      (await api.request(`/v1/agent/purchases/${purchaseId}`)).json, 'purchase');
    if (purchase.purchaseId !== purchaseId) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned another purchase.');
    const suffix = kind === 'REFUND' ? '/refund/receipt' : '/receipt';
    const receipt = parseMarketplaceDto(productReceipt,
      (await api.request(`/v1/agent/purchases/${purchaseId}${suffix}`)).json, 'product receipt');
    if (receipt.kind !== kind) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a different receipt kind.');
    const key = parseMarketplaceDto(receiptVerificationKey,
      (await api.request(`/v1/receipts/keys/${encodeURIComponent(receipt.keyVersion)}`, { auth: 'none' })).json,
      'receipt verification key');
    verifyProductReceipt(receipt, key, purchase);
    return { purchaseId, kind, receipt, verified: true };
  }, { readOnly: true, validatedPublicReceipt: true }, true);
  register('marketplace_product_purchase', 'Reserve one copy of the exact Shop release for 30 minutes. Returns an immutable direct buyer-to-seller paymentRequirementId. Pay using marketplace_payment_pay; entitlement starts only after independent verification. Late confirmed payments can be PAID_UNFULFILLED when publication closed or capacity unavailable; seller must refund directly. One order per buyer/release.', {
    productId: uuid, releaseId: uuid, expectedReleaseHash: z.string().regex(/^[0-9a-f]{64}$/), asset, grossAtomic: positiveAtomic, requestId,
  }, async args => {
    requireAccess(profile, ['products:purchase']);
    const body = { expectedReleaseHash: args.expectedReleaseHash };
    const immutableTerms = { productId: args.productId, releaseId: args.releaseId, asset: args.asset, grossAtomic: args.grossAtomic, ...body };
    return mutate(profiles, profile, 'product-purchase', String(args.releaseId), String(args.requestId), immutableTerms,
      () => api.request(`/v1/agent/releases/${args.releaseId}/purchase`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, {}, true);

  register('marketplace_product_refund', 'Create instructions for the seller voluntary full direct refund to the original buyer. No funds are moved by this call. Pay refundPaymentRequirementId through the local wallet; earned fee and sold quota remain unchanged.', {
    purchaseId: uuid, expectedPurchaseVersion: z.number().int().nonnegative(), requestId,
  }, async args => {
    requireAccess(profile, ['purchases:read', 'purchases:refund']);
    const body = { expectedPurchaseVersion: args.expectedPurchaseVersion };
    return mutate(profiles, profile, 'product-refund', String(args.purchaseId), String(args.requestId), body,
      () => api.request(`/v1/agent/purchases/${args.purchaseId}/refund`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }));
  }, {}, true);

  register('marketplace_products_list', 'List product drafts owned by the configured account. Requires products:read for scoped API keys.', {
    limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['products:read']);
    const result = (await api.request('/v1/agent/products', { query: { limit: Number(args.limit) } })).json;
    return parseMarketplaceDto(z.array(sellerProductListItem).max(100), result, 'seller product list');
  }, { readOnly: true }, true);
  register('marketplace_product_seller_get', 'Read this account’s complete private product draft and a page of immutable releases. Paid Markdown and hashes are seller-private; file bytes are available only for files in this seller’s draft or a selected release. Requires products:read.', {
    productId: uuid, beforeReleaseSequence: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(50),
  }, async args => {
    requireAccess(profile, ['products:read']);
    const productId = String(args.productId);
    const result = (await api.request(`/v1/agent/products/${productId}`, {
      query: {
        limit: Number(args.limit),
        ...(args.beforeReleaseSequence === undefined ? {} : { beforeSequence: Number(args.beforeReleaseSequence) }),
      },
    })).json;
    const detail = parseMarketplaceDto(sellerProductDetail, result, 'seller product detail');
    if (detail.productId !== productId) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a different seller product.');
    return detail;
  }, { readOnly: true }, true);
  register('marketplace_product_draft_create', 'Create one private Shop draft from exact text and explicitly selected ready file IDs. summaryMarkdown is public when published; paidMarkdown remains seller-private until an entitlement authorizes a buyer. Text is preserved as raw Markdown and rendered safely by the website. Upload files first with marketplace_product_file_upload; there is no implicit upload. Retry uncertainty using the same requestId and exact arguments. Scoped credentials need products:write and, when files are attached, files:write.', {
    requestId, title: productMarkdown(160, 1).describe('Public product title.'),
    summaryMarkdown: productMarkdown(20_000, 1).describe('Public long-form Markdown rendered through the website safe Markdown component.'),
    paidMarkdown: productMarkdown(20_000).nullable().optional().describe('Optional paid Markdown. Never exposed in the public catalog.'),
    licenseText: productMarkdown(8_000, 1).describe('Seller-authored license or usage terms.'), asset, priceAtomic: positiveAtomic,
    fileIds: z.array(uuid).max(10).refine(values => new Set(values).size === values.length).default([])
      .describe('Only fileId values returned by explicit marketplace_product_file_upload calls; ordered and never selected implicitly.'),
  }, async args => {
    const fileIds = Array.isArray(args.fileIds) ? args.fileIds.map(String) : [];
    requireAccess(profile, fileIds.length > 0 ? ['products:write', 'files:write'] : ['products:write']);
    const body = {
      title: args.title, summaryMarkdown: args.summaryMarkdown, paidMarkdown: args.paidMarkdown ?? null,
      licenseText: args.licenseText, asset: args.asset, priceAtomic: args.priceAtomic, fileIds,
    };
    return mutate(profiles, profile, 'product-draft-create', profile.accountId, String(args.requestId), body,
      () => api.request('/v1/agent/products', { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        validateResult: value => validateProductMutation(value),
        resultIdentityFields: productMutationIdentityFields,
      });
  }, { destructive: true }, true);
  register('marketplace_product_draft_update', 'Replace an owned Shop draft at its expected version. Provide the complete ordered fileIds list (use an empty list to remove every draft attachment) so no existing files are silently dropped. summaryMarkdown is public on release; paidMarkdown is seller-private. Upload new files explicitly with marketplace_product_file_upload. Retry uncertainty with the same requestId and exact body. Scoped credentials need products:write and files:write when fileIds is non-empty.', {
    productId: uuid, requestId, expectedVersion: z.number().int().nonnegative(), title: productMarkdown(160, 1),
    summaryMarkdown: productMarkdown(20_000, 1), paidMarkdown: productMarkdown(20_000).nullable(),
    licenseText: productMarkdown(8_000, 1), asset, priceAtomic: positiveAtomic,
    fileIds: z.array(uuid).max(10).refine(values => new Set(values).size === values.length),
  }, async args => {
    const productId = String(args.productId), fileIds = (args.fileIds as string[]).map(String);
    requireAccess(profile, fileIds.length > 0 ? ['products:write', 'files:write'] : ['products:write']);
    const body = {
      expectedVersion: args.expectedVersion, title: args.title, summaryMarkdown: args.summaryMarkdown,
      paidMarkdown: args.paidMarkdown, licenseText: args.licenseText, asset: args.asset, priceAtomic: args.priceAtomic, fileIds,
    };
    return mutate(profiles, profile, 'product-draft-update', productId, String(args.requestId), body,
      () => api.request(`/v1/agent/products/${productId}/draft`, { method: 'PUT', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        validateResult: value => validateProductMutation(value, productId),
        resultIdentityFields: productMutationIdentityFields,
      });
  }, { destructive: true }, true);

  register('marketplace_product_publish', 'Freeze an owned immutable Shop release with quantity N and price P. Seller prepays floor(N*P*rate/10000) own-service fee before visibility: ATTO 0.1%, XNO 5%. Returns paymentRequirementId, or opens immediately for zero fee. Closing refunds unused fee to original payer; later seller refunds never restore sold quota or earned fee.', {
    productId: uuid, requestId, expectedVersion: z.number().int().nonnegative(), confirmsDistributionRights: z.literal(true), quantity: z.number().int().positive().max(1000000),
  }, async args => {
    requireAccess(profile, ['products:read', 'products:publish']);
    const body = { expectedVersion: args.expectedVersion, confirmsDistributionRights: true, quantity: args.quantity };
    return mutate(profiles, profile, 'product-publish', String(args.productId), String(args.requestId), body,
      () => api.request(`/v1/agent/products/${args.productId}/publish`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        prepare: async () => {
          const current = asRecord((await api.request(`/v1/agent/products/${args.productId}`, { query: { limit: 1 } })).json);
          const draft = asRecord(current.draft);
          if (draft.version !== args.expectedVersion) throw new ProfileError('PRODUCT_VERSION_CONFLICT', 'Read the current draft version.');
          enforceProductPublishCeiling(profile, String(draft.asset), String(BigInt(String(draft.priceAtomic)) * BigInt(Number(args.quantity))));
          if (Array.isArray(draft.fileIds) && draft.fileIds.length) requireAccess(profile, ['products:write', 'files:write']);
        },
        validateResult: value => validateProductMutation(value, String(args.productId)),
        resultIdentityFields: productMutationIdentityFields,
      });
  }, {}, true);

  register('marketplace_product_unpublish', 'Stop new purchases by unpublishing an owned Shop product. This preserves the immutable release and any existing buyer access. Requires the products:publish scope for scoped API keys; retry uncertainty with the same requestId.', {
    productId: uuid, publicationId: uuid, requestId, expectedVersion: z.number().int().nonnegative(),
  }, async args => {
    requireAccess(profile, ['products:publish']);
    const productId = String(args.productId), body = { expectedVersion: Number(args.expectedVersion), publicationId: args.publicationId };
    return mutate(profiles, profile, 'product-unpublish', productId, String(args.requestId), body,
      () => api.request(`/v1/agent/products/${productId}/unpublish`, { method: 'POST', body, headers: { 'Idempotency-Key': String(args.requestId) } }), {
        validateResult: value => validateProductMutation(value, productId),
        resultIdentityFields: productMutationIdentityFields,
      });
  }, { destructive: true }, true);

  register('marketplace_product_file_upload', 'Explicitly upload one selected local file inside the configured --files-dir boundary and wait for its clean READY scan. The file remains unattached; pass its returned fileId explicitly to marketplace_product_draft_create or marketplace_product_draft_update. Reuse the same requestId and unchanged source bytes to recover an interrupted upload. Scoped credentials require files:write.', {
    sourcePath: uploadSourcePath, requestId,
  }, async args => {
    requireAccess(profile, ['files:write']);
    const ready = await uploadPrivateFile(profiles, profile, api, 'product-file-upload',
      filesDirectory, String(args.sourcePath), String(args.requestId));
    return { file: ready, attached: false, nextStep: 'Pass file.fileId explicitly in marketplace_product_draft_create.fileIds or marketplace_product_draft_update.fileIds.' };
  }, { destructive: true }, true);

  register('marketplace_product_file_download', 'Download a seller-owned immutable Shop file from the exact release sequence and file ID. Marketplace checks account ownership; a file ID alone grants no authority. The verified bytes are atomically written to a new --files-dir path, and existing files are never overwritten. Scoped credentials require products:read and files:read.', {
    productId: uuid, releaseSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1), fileId: uuid,
    destinationPath: downloadDestinationPath,
  }, async args => {
    requireAccess(profile, ['products:read', 'files:read']);
    const productId = String(args.productId), releaseSequence = Number(args.releaseSequence), fileId = String(args.fileId);
    return downloadVerifiedPrivateFile({
      api, filesDirectory, destinationPath: String(args.destinationPath), fileId,
      resolveFile: async () => {
        const response = (await api.request(`/v1/agent/products/${productId}`, { query: { beforeSequence: releaseSequence + 1, limit: 1 } })).json;
        const detail = parseMarketplaceDto(sellerProductDetail, response, 'seller product detail');
        if (detail.productId !== productId) throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Marketplace returned a different seller product.');
        const release = detail.releases.find(item => item.releaseSequence === releaseSequence);
        if (!release) throw new MarketplaceApiError('PRODUCT_RELEASE_NOT_FOUND', 'That seller-owned release sequence is unavailable.');
        const file = release.files.find(item => item.fileId === fileId);
        if (!file) throw new MarketplaceApiError('FILE_NOT_IN_RELEASE', 'That file ID is not present in the requested seller release.');
        return { entry: file, buildResult: savedAs => ({ productId, releaseId: release.releaseId, releaseSequence, file, savedAs }) };
      },
    });
  }, { destructive: true }, true);

  register('marketplace_purchase_file_download', 'Download one immutable file from this buyer’s active purchased release to a new path below --files-dir. Marketplace authorizes the file and bytes and SHA-256 are verified. Scoped credentials require purchases:read and files:read.', {
    purchaseId: uuid, fileId: uuid, destinationPath: downloadDestinationPath,
  }, async args => {
    requireAccess(profile, ['purchases:read', 'files:read']);
    const purchaseId = String(args.purchaseId), fileId = String(args.fileId);
    return downloadVerifiedPrivateFile({
      api, filesDirectory, destinationPath: String(args.destinationPath), fileId,
      resolveFile: async () => {
        const purchase = parseMarketplaceDto(productPurchaseResult,
          (await api.request(`/v1/agent/purchases/${purchaseId}`)).json, 'purchase');
        if (purchase.purchaseId !== purchaseId || purchase.status !== 'ACTIVE') throw new MarketplaceApiError('PURCHASE_NOT_ACTIVE', 'Paid files require an active entitlement.');
        const content = parseMarketplaceDto(productPaidContent,
          (await api.request(`/v1/agent/purchases/${purchaseId}/content`)).json, 'paid purchase content');
        if (content.purchaseId !== purchaseId || content.releaseId !== purchase.releaseId || content.manifestHash !== purchase.manifestHash) {
          throw new MarketplaceApiError('MARKETPLACE_PROTOCOL', 'Paid content differs from the purchased immutable release.');
        }
        const file = content.files.find(item => item.fileId === fileId);
        if (!file) throw new MarketplaceApiError('FILE_NOT_IN_PURCHASE', 'The selected file is not in this purchased release.');
        return { entry: file, buildResult: savedAs => ({ purchaseId, releaseId: purchase.releaseId, file, savedAs }) };
      },
    });
  }, { destructive: true }, true);
}
