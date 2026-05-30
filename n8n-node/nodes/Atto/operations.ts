/* eslint-disable @n8n/community-nodes/no-restricted-globals */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
/* eslint-disable @n8n/community-nodes/require-node-api-error */
import {
	AttoAddress,
	AttoAlgorithm,
	AttoAmount,
	AttoMnemonic,
	AttoPrivateKey,
	AttoUnit,
	privateKeyToSigner,
	toAttoIndex,
	toPrivateKey,
	toPublicKey,
	toSeedAsync,
	type AttoReceivable,
} from '@attocash/commons-core';
import { accountToJson, receivableToJson, transactionToJson } from '@attocash/commons-node';
import { AttoNodeClientAsyncBuilder, type AttoNodeClientAsync } from '@attocash/commons-node-remote';
import { AttoWalletAsyncBuilder } from '@attocash/commons-wallet';
import { AttoWorkerAsyncBuilder } from '@attocash/commons-worker-remote';
import type { ICredentialDataDecryptedObject, IDataObject } from 'n8n-workflow';

export type AttoOperation =
	| 'deriveAccount'
	| 'getAccount'
	| 'sendTransaction'
	| 'receivePending'
	| 'changeRepresentative';

type SecretType = 'mnemonic' | 'privateKey';

type AttoCredentials = {
	nodeUrl?: string;
	workerUrl?: string;
	apiKey?: string;
	authHeaderName?: string;
	authHeaderPrefix?: string;
	walletMaterialType?: SecretType;
	walletSecret?: string;
	keyIndex?: number | string;
};

export type AttoParameters = Record<string, unknown>;

type DerivedAccount = {
	secretType: SecretType;
	keyIndex: number;
	privateKey: AttoPrivateKey;
	publicKey: ReturnType<typeof toPublicKey>;
	address: AttoAddress;
	seed?: Awaited<ReturnType<typeof toSeedAsync>>;
};

function normalizeCredentials(credentials: ICredentialDataDecryptedObject | undefined): AttoCredentials {
	return (credentials ?? {}) as AttoCredentials;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
	const normalized = text(value);
	return normalized ? normalized : undefined;
}

function positiveInteger(value: unknown, fieldName: string): number {
	const numberValue = typeof value === 'number' ? value : Number(value);

	if (!Number.isInteger(numberValue) || numberValue < 0) {
		throw new Error(`${fieldName} must be a non-negative integer`);
	}

	return numberValue;
}

function parseSecretType(value: unknown, fieldName: string): SecretType {
	if (value === 'mnemonic' || value === 'privateKey') return value;
	throw new Error(`${fieldName} must be either mnemonic or privateKey`);
}

function secretInput(
	parameters: AttoParameters,
	credentials: AttoCredentials,
): { secretType: SecretType; walletSecret: string; keyIndex: number } {
	const source = text(parameters.secretSource || 'credentials');

	if (source === 'node') {
		const walletSecret = text(parameters.walletSecret);
		if (!walletSecret) throw new Error('Wallet Secret is required');

		return {
			secretType: parseSecretType(parameters.walletSecretType ?? 'mnemonic', 'Wallet Secret Type'),
			walletSecret,
			keyIndex: positiveInteger(parameters.keyIndex ?? 0, 'Key Index'),
		};
	}

	const walletSecret = text(credentials.walletSecret);
	if (!walletSecret) throw new Error('Atto credentials must include a Wallet Secret');

	return {
		secretType: parseSecretType(credentials.walletMaterialType ?? 'mnemonic', 'Credential Wallet Secret Type'),
		walletSecret,
		keyIndex: positiveInteger(credentials.keyIndex ?? 0, 'Credential Key Index'),
	};
}

export async function deriveAccountFromSecret(
	parameters: AttoParameters,
	credentials?: ICredentialDataDecryptedObject,
): Promise<DerivedAccount> {
	const input = secretInput(parameters, normalizeCredentials(credentials));
	const index = toAttoIndex(input.keyIndex);

	if (input.secretType === 'mnemonic') {
		const mnemonic = AttoMnemonic.fromPhrase(input.walletSecret);
		const seed = await toSeedAsync(mnemonic);
		const privateKey = toPrivateKey(seed, index);
		const publicKey = toPublicKey(privateKey);
		const address = new AttoAddress(AttoAlgorithm.V1, publicKey);

		return {
			secretType: input.secretType,
			keyIndex: input.keyIndex,
			privateKey,
			publicKey,
			address,
			seed,
		};
	}

	const privateKey = AttoPrivateKey.Companion.parse(input.walletSecret);
	const publicKey = toPublicKey(privateKey);
	const address = new AttoAddress(AttoAlgorithm.V1, publicKey);

	return {
		secretType: input.secretType,
		keyIndex: input.keyIndex,
		privateKey,
		publicKey,
		address,
	};
}

function requireNodeUrl(credentials: AttoCredentials): string {
	const nodeUrl = text(credentials.nodeUrl);
	if (!nodeUrl) throw new Error('Atto credentials must include a Node Base URL');
	return nodeUrl.replace(/\/+$/, '');
}

function requireWorkerUrl(credentials: AttoCredentials): string {
	const workerUrl = text(credentials.workerUrl);
	if (!workerUrl) throw new Error('Atto credentials must include a Worker Base URL');
	return workerUrl.replace(/\/+$/, '');
}

function applyHeaders<T extends { header(name: string, value: string): T }>(
	builder: T,
	credentials: AttoCredentials,
): T {
	const apiKey = text(credentials.apiKey);
	if (!apiKey) return builder;

	const header = text(credentials.authHeaderName || 'Authorization');
	if (!header) throw new Error('API Key Header is required when API Key is set');

	const prefix = text(credentials.authHeaderPrefix);
	return builder.header(header, prefix ? `${prefix} ${apiKey}` : apiKey);
}

function createNodeClient(credentials: AttoCredentials): AttoNodeClientAsync {
	return applyHeaders(new AttoNodeClientAsyncBuilder(requireNodeUrl(credentials)), credentials).build();
}

async function createWalletRuntime(
	parameters: AttoParameters,
	credentials: AttoCredentials,
): Promise<{
	node: AttoNodeClientAsync;
	derived: DerivedAccount;
	wallet: ReturnType<AttoWalletAsyncBuilder['build']>;
}> {
	const derived = await deriveAccountFromSecret(parameters, credentials as ICredentialDataDecryptedObject);
	const node = createNodeClient(credentials);
	const worker = applyHeaders(new AttoWorkerAsyncBuilder(requireWorkerUrl(credentials)), credentials).build();

	const builder = new AttoWalletAsyncBuilder(node as never, worker as never);
	if (derived.seed) {
		builder.signerProviderSeed(derived.seed as never);
	} else {
		builder.signerProviderFunction({
			get: async () => privateKeyToSigner(derived.privateKey) as never,
		} as never);
	}

	const wallet = builder.build();
	await wallet.openAccount(toAttoIndex(derived.keyIndex) as never);

	return { node, derived, wallet };
}

function parseAddress(value: unknown, fieldName: string): AttoAddress {
	const raw = text(value);
	if (!raw) throw new Error(`${fieldName} is required`);

	try {
		return AttoAddress.parse(raw);
	} catch {
		throw new Error(`${fieldName} must be a valid Atto address`);
	}
}

function parseOptionalAddress(value: unknown, fieldName: string): AttoAddress | undefined {
	const raw = optionalText(value);
	return raw ? parseAddress(raw, fieldName) : undefined;
}

function parseAmount(amount: unknown, unit: unknown, fieldName: string): AttoAmount {
	const raw = text(amount);
	if (!raw) throw new Error(`${fieldName} is required`);

	try {
		const amountValue =
			text(unit).toUpperCase() === 'RAW'
				? AttoAmount.from(AttoUnit.RAW, raw)
				: AttoAmount.from(AttoUnit.ATTO, raw);

		if (amountValue.toString() === '0') {
			throw new Error('zero');
		}

		return amountValue;
	} catch {
		throw new Error(`${fieldName} must be a positive Atto amount`);
	}
}

function assertSameAddress(expected: AttoAddress, actual: AttoAddress, fieldName: string) {
	if (!expected.equals(actual)) {
		throw new Error(`${fieldName} must match the address derived from the wallet secret`);
	}
}

function parseJsonObject(value: string): IDataObject {
	return JSON.parse(value) as IDataObject;
}

function amountOutput(amount: AttoAmount): IDataObject {
	return {
		raw: amount.toString(),
		atto: amount.toFormattedString(AttoUnit.ATTO),
	};
}

function transactionOutput(transaction: { hash: { toString(): string } }, status: string): IDataObject {
	return {
		status,
		hash: transaction.hash.toString(),
		transaction: parseJsonObject(transactionToJson(transaction as never)),
	};
}

async function firstReceivable(
	node: AttoNodeClientAsync,
	address: AttoAddress,
	minAmount: AttoAmount,
	timeoutMs: number,
): Promise<AttoReceivable> {
	return await new Promise((resolve, reject) => {
		let settled = false;
		const state: { job?: { cancel?: () => void; close?: () => void } } = {};

		const cleanup = () => {
			try {
				state.job?.cancel?.();
				state.job?.close?.();
			} catch {
				// Stream cleanup is best effort after the first result or timeout.
			}
		};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(`No pending Atto transaction found within ${timeoutMs}ms`));
		}, timeoutMs);

		state.job = node.onReceivableByAddresses(
			[address] as never,
			minAmount as never,
			(receivable) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				resolve(receivable);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				cleanup();
				reject(error ?? new Error('Atto receivable listener stopped'));
			},
		) as { cancel?: () => void; close?: () => void };
	});
}

export async function executeAttoOperation(
	operation: AttoOperation,
	parameters: AttoParameters,
	credentials?: ICredentialDataDecryptedObject,
): Promise<IDataObject> {
	const attoCredentials = normalizeCredentials(credentials);

	if (operation === 'deriveAccount') {
		const derived = await deriveAccountFromSecret(parameters, credentials);
		return {
			address: derived.address.value,
			publicKey: derived.publicKey.toString(),
			keyIndex: derived.keyIndex,
			secretType: derived.secretType,
		};
	}

	if (operation === 'getAccount') {
		const node = createNodeClient(attoCredentials);
		const address = parseAddress(parameters.lookupAddress, 'Account Address');
		const account = await node.accountByPublicKey(address.publicKey as never);

		if (!account) {
			return {
				found: false,
				address: address.value,
			};
		}

		return {
			found: true,
			address: account.address.value,
			publicKey: account.publicKey.toString(),
			balance: amountOutput(account.balance),
			representative: account.representativeAddress.value,
			height: account.height.toString(),
			frontier: account.lastTransactionHash.toString(),
			account: parseJsonObject(accountToJson(account as never)),
		};
	}

	if (operation === 'sendTransaction') {
		const fromAddress = parseAddress(parameters.fromAddress, 'From Account');
		const destinationAddress = parseAddress(parameters.destinationAddress, 'Destination Account');
		const amount = parseAmount(parameters.amount, parameters.amountUnit, 'Amount');
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		assertSameAddress(runtime.derived.address, fromAddress, 'From Account');
		const transaction = await runtime.wallet.sendByAddress(
			fromAddress as never,
			destinationAddress as never,
			amount as never,
			null,
		);

		return {
			...transactionOutput(transaction, 'published'),
			from: fromAddress.value,
			to: destinationAddress.value,
			amount: amountOutput(amount),
		};
	}

	if (operation === 'receivePending') {
		const minAmount = parseAmount(parameters.minAmount ?? '1', parameters.minAmountUnit ?? 'RAW', 'Minimum Amount');
		const timeoutMs = positiveInteger(parameters.timeoutMs ?? 5000, 'Timeout');
		const requestedAddress = parseOptionalAddress(parameters.receiveAddress, 'Account Address');
		const requestedRepresentative = parseOptionalAddress(
			parameters.receiveRepresentativeAddress,
			'Representative Account',
		);
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		const accountAddress = requestedAddress ?? runtime.derived.address;
		assertSameAddress(runtime.derived.address, accountAddress, 'Account Address');

		const receivable = await firstReceivable(runtime.node, accountAddress, minAmount, timeoutMs);
		const representative = requestedRepresentative ?? accountAddress;
		const transaction = await runtime.wallet.receive(
			receivable as never,
			representative as never,
			null,
		);

		return {
			...transactionOutput(transaction, 'received'),
			account: accountAddress.value,
			amount: amountOutput(receivable.amount),
			receivable: parseJsonObject(receivableToJson(receivable as never)),
		};
	}

	if (operation === 'changeRepresentative') {
		const representativeAddress = parseAddress(parameters.representativeAddress, 'Representative Account');
		const requestedAddress = parseOptionalAddress(parameters.changeAddress, 'Account Address');
		const runtime = await createWalletRuntime(parameters, attoCredentials);
		const accountAddress = requestedAddress ?? runtime.derived.address;
		assertSameAddress(runtime.derived.address, accountAddress, 'Account Address');
		const transaction = await runtime.wallet.change(
			toAttoIndex(runtime.derived.keyIndex) as never,
			representativeAddress as never,
			null,
		);

		return {
			...transactionOutput(transaction, 'representative_changed'),
			account: accountAddress.value,
			representative: representativeAddress.value,
		};
	}

	throw new Error(`Unsupported Atto operation: ${operation}`);
}
