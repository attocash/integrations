/* eslint-disable @n8n/community-nodes/no-restricted-imports -- Commons is bundled into this file during the build. */
import {
	AttoAccount as CommonsAccount,
	AttoAccountEntry as CommonsAccountEntry,
	AttoAddress as CommonsAddress,
	AttoAlgorithm,
	AttoAmount as CommonsAmount,
	AttoBlock as CommonsBlock,
	AttoHash,
	AttoMnemonic,
	AttoPrivateKey,
	AttoPublicKey,
	AttoReceivable as CommonsReceivable,
	AttoTransaction as CommonsTransaction,
	AttoUnit,
	AttoWork,
	attoAccountChange,
	attoAccountOpen,
	attoAccountReceive,
	attoAccountSend,
	attoBlockWorkTarget,
	privateKeyToSigner,
	toAttoIndex,
	toPrivateKey,
	toSeedAsync,
	type AttoSigner as CommonsSigner,
} from '@attocash/commons-core';
import type { IDataObject } from 'n8n-workflow';

const ADDRESS_PREFIX = 'atto://';

export type AttoSecretType = 'mnemonic' | 'privateKey';

export type AttoCredentials = {
	nodeUrl?: string;
	workerUrl?: string;
	apiKey?: string;
	authHeaderName?: string;
	authHeaderPrefix?: string;
	walletMaterialType?: AttoSecretType;
	walletSecret?: string;
	keyIndex?: number | string;
};

export type AttoStreamEvent = 'receivable' | 'account' | 'transaction' | 'accountEntry';

export type AttoAddress = {
	algorithm: 'V1';
	publicKey: string;
	path: string;
	value: string;
	model: CommonsAddress;
};

export type AttoStreamRequest = {
	event: AttoStreamEvent;
	route: 'all' | 'hash' | 'publicKey' | 'addresses';
	addresses?: AttoAddress[];
	hash?: string;
	fromHeight?: string;
	toHeight?: string;
	minAmount?: string;
};

export type AttoStreamModel = {
	toJson(): string;
};

export type DerivedAddress = AttoAddress & {
	keyIndex: number;
	secretType: AttoSecretType;
	signer: CommonsSigner;
};

export type AttoBlockModel = CommonsBlock;

export type SignedTransaction = {
	model: CommonsTransaction;
	raw: IDataObject;
};

function normalizeIndex(value: unknown, fieldName: string): number {
	const numberValue = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(numberValue) || numberValue < 0 || numberValue > 0x7fff_ffff) {
		throw new Error(`${fieldName} must be an integer between 0 and 2147483647`);
	}
	return numberValue;
}

function secretType(value: unknown, fieldName: string): AttoSecretType {
	if (value === 'mnemonic' || value === 'privateKey') return value;
	throw new Error(`${fieldName} must be either mnemonic or privateKey`);
}

function secretInput(
	parameters: Record<string, unknown>,
	credentials: AttoCredentials,
): { type: AttoSecretType; secret: string; index: number } {
	const source = String(parameters.secretSource ?? 'credentials').trim();
	if (source === 'node') {
		const secret = String(parameters.walletSecret ?? '').trim();
		if (!secret) throw new Error('Wallet Secret is required');
		return {
			type: secretType(parameters.walletSecretType ?? 'mnemonic', 'Wallet Secret Type'),
			secret,
			index: normalizeIndex(parameters.keyIndex ?? 0, 'Key Index'),
		};
	}

	const secret = String(credentials.walletSecret ?? '').trim();
	if (!secret) throw new Error('Atto credentials must include a Wallet Secret');
	return {
		type: secretType(credentials.walletMaterialType ?? 'mnemonic', 'Credential Wallet Secret Type'),
		secret,
		index: normalizeIndex(credentials.keyIndex ?? 0, 'Credential Key Index'),
	};
}

function addressOutput(model: CommonsAddress): AttoAddress {
	return {
		algorithm: model.algorithm.name,
		publicKey: model.publicKey.toString(),
		path: model.path,
		value: model.value,
		model,
	};
}

function dataObjectFromJson(value: string, entityName: string): IDataObject {
	const parsed = parseAttoJson(value);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${entityName} JSON must contain an object`);
	}
	return parsed as IDataObject;
}

function accountModel(value: IDataObject): CommonsAccount {
	return CommonsAccount.fromJson(stringifyAttoJson(value));
}

function accountEntryModel(value: IDataObject): CommonsAccountEntry {
	return CommonsAccountEntry.fromJson(stringifyAttoJson(value));
}

function blockModel(value: IDataObject | CommonsBlock): CommonsBlock {
	if ('toJson' in value && typeof value.toJson === 'function' && 'hash' in value) return value as CommonsBlock;
	return CommonsBlock.fromJson(stringifyAttoJson(value));
}

function receivableModel(value: IDataObject): CommonsReceivable {
	return CommonsReceivable.fromJson(stringifyAttoJson(value));
}

function transactionModel(value: IDataObject): CommonsTransaction {
	return CommonsTransaction.fromJson(stringifyAttoJson(value));
}

function amountModel(value: unknown): CommonsAmount {
	if (value instanceof CommonsAmount) return value;
	return CommonsAmount.from(AttoUnit.RAW, String(value));
}

export function addressFromPublicKey(publicKey: string): AttoAddress {
	const model = new CommonsAddress(
		AttoAlgorithm.V1,
		AttoPublicKey.Companion.parse(publicKey.trim()),
	);
	return addressOutput(model);
}

export function parseAddress(value: unknown): AttoAddress {
	const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
	const withPrefix = normalized.startsWith(ADDRESS_PREFIX) ? normalized : `${ADDRESS_PREFIX}${normalized}`;
	return addressOutput(CommonsAddress.parse(withPrefix));
}

export async function deriveAddressFromSecret(
	parameters: Record<string, unknown>,
	credentials: AttoCredentials = {},
): Promise<DerivedAddress> {
	const input = secretInput(parameters, credentials);
	let privateKey: AttoPrivateKey;

	if (input.type === 'mnemonic') {
		const phrase = input.secret.normalize('NFKD').replace(/\s+/g, ' ').trim();
		if (phrase.split(' ').length !== 24) throw new Error('Wallet Secret mnemonic must contain 24 words');
		privateKey = await toPrivateKey(
			await toSeedAsync(await AttoMnemonic.fromPhrase(phrase)),
			toAttoIndex(input.index),
		);
	} else {
		privateKey = AttoPrivateKey.Companion.parse(input.secret);
	}

	const signer = await privateKeyToSigner(privateKey);
	return {
		...addressOutput(signer.address),
		keyIndex: input.index,
		secretType: input.type,
		signer,
	};
}

export function parseHash(value: unknown): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	return AttoHash.Companion.parse(normalized).toString();
}

export function parseAmount(value: unknown, unit: unknown, fieldName: string): CommonsAmount {
	const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
	if (!normalized) throw new Error(`${fieldName} is required`);
	const amount = CommonsAmount.from(
		String(unit).toUpperCase() === 'RAW' ? AttoUnit.RAW : AttoUnit.ATTO,
		normalized,
	);
	if (amount.toString() === '0') throw new Error(`${fieldName} must be a positive Atto amount`);
	return amount;
}

export function amountOutput(value: unknown): IDataObject {
	const amount = amountModel(value);
	return {
		raw: amount.toString(),
		atto: amount.toFormattedString(AttoUnit.ATTO),
	};
}

export function parseAttoJson(value: string): unknown {
	const safeJson = value.replace(
		/("(?:amount|balance|previousBalance|height)"\s*:\s*)(-?\d{16,})/g,
		'$1"$2"',
	);
	return JSON.parse(safeJson) as unknown;
}

export function stringifyAttoJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/("(?:amount|balance|previousBalance|height)"\s*:\s*)"(-?\d+)"/g,
		'$1$2',
	);
}

export function blockHash(block: IDataObject | CommonsBlock): string {
	return blockModel(block).hash.toString();
}

export async function signedTransaction(
	block: CommonsBlock,
	signer: CommonsSigner,
	work: string,
): Promise<SignedTransaction> {
	const attoWork = AttoWork.Companion.parse(work);
	const model = new CommonsTransaction(block, await signer.signBlock(block), attoWork);
	return {
		model,
		raw: dataObjectFromJson(model.toJson(), 'Atto transaction'),
	};
}

export function workTarget(block: IDataObject | CommonsBlock): string {
	return attoBlockWorkTarget(blockModel(block));
}

export function createSendBlock(
	account: IDataObject,
	receiver: AttoAddress,
	amount: CommonsAmount,
	timestamp: number,
): CommonsBlock {
	const model = accountModel(account);
	const balance = BigInt(model.balance.toString());
	const rawAmount = BigInt(amount.toString());
	if (rawAmount > balance) {
		throw new Error(`Account balance ${balance} is not enough to send ${rawAmount}`);
	}
	if (model.publicKey.toString() === receiver.publicKey) {
		throw new Error('Destination Address must differ from the source address');
	}
	return attoAccountSend(
		model,
		receiver.model,
		amount,
		new Date(timestamp).toISOString(),
	).block;
}

export function createReceiveBlock(
	account: IDataObject | undefined,
	receivable: IDataObject,
	representative: AttoAddress,
	timestamp: number,
): CommonsBlock {
	const model = receivableModel(receivable);
	const timestampIso = new Date(timestamp).toISOString();
	return account
		? attoAccountReceive(accountModel(account), model, timestampIso).block
		: attoAccountOpen(representative.model, model, timestampIso).block;
}

export function createChangeBlock(
	account: IDataObject,
	representative: AttoAddress,
	timestamp: number,
): CommonsBlock {
	return attoAccountChange(
		accountModel(account),
		representative.model,
		new Date(timestamp).toISOString(),
	).block;
}

export function accountOutput(account: IDataObject): IDataObject {
	const model = accountModel(account);
	return {
		found: true,
		address: model.address.value,
		publicKey: model.publicKey.toString(),
		balance: amountOutput(model.balance),
		representativeAddress: model.representativeAddress.value,
		height: model.height.toString(),
		frontier: model.lastTransactionHash.toString(),
	};
}

export function receivableOutput(receivable: IDataObject): IDataObject {
	const model = receivableModel(receivable);
	return {
		hash: model.hash.toString(),
		address: model.receiverAddress.value,
		fromAddress: model.address.value,
		amount: amountOutput(model.amount),
	};
}

export function transactionOutput(
	transaction: IDataObject,
	status?: string,
): IDataObject {
	const model = transactionModel(transaction);
	return {
		...(status ? { status } : {}),
		hash: model.hash.toString(),
		address: model.address.value,
		height: model.height.toString(),
	};
}

export function accountEntryOutput(entry: IDataObject): IDataObject {
	const model = accountEntryModel(entry);
	return {
		hash: model.hash.toString(),
		address: model.address.value,
		subjectAddress: model.subjectAddress.value,
		height: model.height.toString(),
		blockType: model.blockType.name,
		previousBalance: amountOutput(model.previousBalance),
		balance: amountOutput(model.balance),
	};
}

export function streamEventOutput(
	event: AttoStreamEvent,
	value: AttoStreamModel | IDataObject,
): IDataObject {
	const item =
		'toJson' in value && typeof value.toJson === 'function'
			? dataObjectFromJson(value.toJson(), `Atto ${event}`)
			: value;
	if (event === 'account') return accountOutput(item);
	if (event === 'receivable') return receivableOutput(item);
	if (event === 'transaction') return transactionOutput(item);
	return accountEntryOutput(item);
}
