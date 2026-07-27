import {
	NodeConnectionTypes,
	NodeApiError,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { executeAttoOperation, type AttoOperation } from './operations';

type AttoParameterName =
	| 'secretSource'
	| 'walletSecretType'
	| 'walletSecret'
	| 'keyIndex'
	| 'address'
	| 'addressSource'
	| 'addresses'
	| 'queryMode'
	| 'hash'
	| 'fromHeight'
	| 'toHeight'
	| 'destinationAddress'
	| 'amount'
	| 'amountUnit'
	| 'minAmount'
	| 'minAmountUnit'
	| 'representativeAddress'
	| 'timeoutMs'
	| 'maxItems';

type AttoResource = 'address' | 'account' | 'receivable' | 'transaction' | 'accountEntry' | 'representative';

const SECRET_PARAMETER_NAMES = ['secretSource', 'walletSecretType', 'walletSecret', 'keyIndex'] as const;

const OPERATION_PARAMETER_NAMES: Record<AttoOperation, readonly AttoParameterName[]> = {
	deriveAddress: SECRET_PARAMETER_NAMES,
	deriveAccount: SECRET_PARAMETER_NAMES,
	getAccount: ['address'],
	getReceivables: ['addressSource', 'addresses', 'minAmount', 'minAmountUnit', 'maxItems', 'timeoutMs'],
	getTransactions: ['queryMode', 'addresses', 'hash', 'fromHeight', 'toHeight', 'maxItems', 'timeoutMs'],
	sendTransaction: [...SECRET_PARAMETER_NAMES, 'destinationAddress', 'amount', 'amountUnit', 'timeoutMs'],
	receivePending: [...SECRET_PARAMETER_NAMES, 'representativeAddress', 'timeoutMs'],
	getAccountEntries: ['queryMode', 'addresses', 'hash', 'fromHeight', 'toHeight', 'maxItems', 'timeoutMs'],
	changeRepresentative: [...SECRET_PARAMETER_NAMES, 'representativeAddress'],
};

const DEFAULT_OPERATION_BY_RESOURCE: Record<AttoResource, AttoOperation> = {
	address: 'deriveAddress',
	account: 'getAccount',
	receivable: 'getReceivables',
	transaction: 'getTransactions',
	accountEntry: 'getAccountEntries',
	representative: 'changeRepresentative',
};

const SIGNING_OPERATIONS = [
	'deriveAddress',
	'sendTransaction',
	'receivePending',
	'changeRepresentative',
];

const STREAM_GET_OPERATIONS = ['getReceivables', 'getTransactions', 'getAccountEntries'];
const PUBLISH_OPERATIONS = ['sendTransaction', 'receivePending'];

const DEFAULT_PARAMETER_VALUES: Record<AttoParameterName, string | number | boolean> = {
	secretSource: 'credentials',
	walletSecretType: 'mnemonic',
	walletSecret: '',
	keyIndex: 0,
	address: '',
	addressSource: 'credentials',
	addresses: '',
	queryMode: 'credentials',
	hash: '',
	fromHeight: '',
	toHeight: '',
	destinationAddress: '',
	amount: '',
	amountUnit: 'ATTO',
	minAmount: '1',
	minAmountUnit: 'RAW',
	representativeAddress: '',
	timeoutMs: 5000,
	maxItems: 25,
};

const AMOUNT_UNITS = [
	{
		name: 'ATTO',
		value: 'ATTO',
	},
	{
		name: 'Raw',
		value: 'RAW',
	},
];

function defaultParameterValue(name: AttoParameterName, operation: AttoOperation): string | number | boolean {
	if (name === 'timeoutMs' && PUBLISH_OPERATIONS.includes(operation)) return 60000;
	return DEFAULT_PARAMETER_VALUES[name];
}

export class Atto implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Atto',
		name: 'atto',
		icon: {
			light: 'file:atto.svg',
			dark: 'file:atto.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Use Atto addresses, accounts, receivables, transactions, and account entries',
		defaults: {
			name: 'Atto',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'attoApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Account',
						value: 'account',
					},
					{
						name: 'Account Entry',
						value: 'accountEntry',
					},
					{
						name: 'Address',
						value: 'address',
					},
					{
						name: 'Receivable',
						value: 'receivable',
					},
					{
						name: 'Representative',
						value: 'representative',
					},
					{
						name: 'Transaction',
						value: 'transaction',
					},
				],
				default: 'address',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['address'],
					},
				},
				options: [
					{
						name: 'Derive',
						value: 'deriveAddress',
						action: 'Derive an address',
					},
				],
				default: 'deriveAddress',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['account'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'getAccount',
						action: 'Get an account',
					},
				],
				default: 'getAccount',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['receivable'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'getReceivables',
						action: 'Get a receivable',
					},
					{
						name: 'Receive',
						value: 'receivePending',
						action: 'Receive a receivable',
					},
				],
				default: 'getReceivables',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['transaction'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'getTransactions',
						action: 'Get a transaction',
					},
					{
						name: 'Send',
						value: 'sendTransaction',
						action: 'Send a transaction',
					},
				],
				default: 'getTransactions',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['accountEntry'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'getAccountEntries',
						action: 'Get an account entry',
					},
				],
				default: 'getAccountEntries',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['representative'],
					},
				},
				options: [
					{
						name: 'Change',
						value: 'changeRepresentative',
						action: 'Change a representative',
					},
				],
				default: 'changeRepresentative',
			},
			{
				displayName: 'Secret Source',
				name: 'secretSource',
				type: 'options',
				options: [
					{
						name: 'Credentials',
						value: 'credentials',
					},
					{
						name: 'Node Parameters',
						value: 'node',
					},
				],
				default: 'credentials',
				displayOptions: {
					show: {
						operation: SIGNING_OPERATIONS,
					},
				},
				description: 'Where to read the wallet secret from. Use credentials for real funds.',
			},
			{
				displayName: 'Wallet Secret Type',
				name: 'walletSecretType',
				type: 'options',
				options: [
					{
						name: 'Mnemonic Phrase',
						value: 'mnemonic',
					},
					{
						name: 'Private Key',
						value: 'privateKey',
					},
				],
				default: 'mnemonic',
				displayOptions: {
					show: {
						operation: SIGNING_OPERATIONS,
						secretSource: ['node'],
					},
				},
				description: 'Format of the wallet secret supplied as a node parameter',
			},
			{
				displayName: 'Wallet Secret',
				name: 'walletSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				displayOptions: {
					show: {
						operation: SIGNING_OPERATIONS,
						secretSource: ['node'],
					},
				},
				description: 'Mnemonic phrase or private key used only for signing',
			},
			{
				displayName: 'Key Index',
				name: 'keyIndex',
				type: 'number',
				default: 0,
				typeOptions: {
					minValue: 0,
					numberPrecision: 0,
				},
				displayOptions: {
					show: {
						operation: SIGNING_OPERATIONS,
						secretSource: ['node'],
						walletSecretType: ['mnemonic'],
					},
				},
				description: 'Derivation index used when Wallet Secret Type is Mnemonic Phrase',
			},
			{
				displayName: 'Address',
				name: 'address',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['getAccount'],
					},
				},
				description: 'Atto address to look up',
			},
			{
				displayName: 'Address Source',
				name: 'addressSource',
				type: 'options',
				options: [
					{
						name: 'Credentials',
						value: 'credentials',
					},
					{
						name: 'Manual Addresses',
						value: 'manual',
					},
				],
				default: 'credentials',
				displayOptions: {
					show: {
						operation: ['getReceivables'],
					},
				},
				description: 'Where receivable addresses come from',
			},
			{
				displayName: 'Query Mode',
				name: 'queryMode',
				type: 'options',
				options: [
					{
						name: 'All',
						value: 'all',
					},
					{
						name: 'Credentials Address',
						value: 'credentials',
					},
					{
						name: 'Hash',
						value: 'hash',
					},
					{
						name: 'Manual Addresses',
						value: 'manual',
					},
				],
				default: 'credentials',
				displayOptions: {
					show: {
						operation: ['getTransactions', 'getAccountEntries'],
					},
				},
				description: 'How to select transactions or account entries',
			},
			{
				displayName: 'Addresses',
				name: 'addresses',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['getReceivables'],
						addressSource: ['manual'],
					},
				},
				description: 'Comma-separated or newline-separated Atto addresses',
			},
			{
				displayName: 'Addresses',
				name: 'addresses',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['getTransactions', 'getAccountEntries'],
						queryMode: ['manual'],
					},
				},
				description: 'Comma-separated or newline-separated Atto addresses',
			},
			{
				displayName: 'Hash',
				name: 'hash',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['getTransactions', 'getAccountEntries'],
						queryMode: ['hash'],
					},
				},
				description: 'Transaction or account entry hash',
			},
			{
				displayName: 'From Height',
				name: 'fromHeight',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['getTransactions', 'getAccountEntries'],
						queryMode: ['credentials', 'manual'],
					},
				},
				description: 'Optional first account height to include',
			},
			{
				displayName: 'To Height',
				name: 'toHeight',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['getTransactions', 'getAccountEntries'],
						queryMode: ['credentials', 'manual'],
					},
				},
				description: 'Optional last account height to include',
			},
			{
				displayName: 'Destination Address',
				name: 'destinationAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Recipient Atto address',
			},
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Positive amount to send',
			},
			{
				displayName: 'Amount Unit',
				name: 'amountUnit',
				type: 'options',
				options: AMOUNT_UNITS,
				default: 'ATTO',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Unit used for Amount',
			},
			{
				displayName: 'Minimum Amount',
				name: 'minAmount',
				type: 'string',
				default: '1',
				displayOptions: {
					show: {
						operation: ['getReceivables'],
					},
				},
				description: 'Smallest receivable amount to match',
			},
			{
				displayName: 'Minimum Amount Unit',
				name: 'minAmountUnit',
				type: 'options',
				options: AMOUNT_UNITS,
				default: 'RAW',
				displayOptions: {
					show: {
						operation: ['getReceivables'],
					},
				},
				description: 'Unit used for Minimum Amount',
			},
			{
				displayName: 'Representative Address',
				name: 'representativeAddress',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['receivePending'],
					},
				},
				description: 'Representative for opening a receiving address. Leave empty to use the derived address.',
			},
			{
				displayName: 'Representative Address',
				name: 'representativeAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['changeRepresentative'],
					},
				},
				description: 'New representative address',
			},
			{
				displayName: 'Max Items',
				name: 'maxItems',
				type: 'number',
				default: 25,
				typeOptions: {
					minValue: 1,
					numberPrecision: 0,
				},
				displayOptions: {
					show: {
						operation: STREAM_GET_OPERATIONS,
					},
				},
				description: 'Maximum number of stream items to collect before returning',
			},
			{
				displayName: 'Timeout',
				name: 'timeoutMs',
				type: 'number',
				default: 5000,
				typeOptions: {
					minValue: 1,
					numberPrecision: 0,
				},
				displayOptions: {
					show: {
						operation: STREAM_GET_OPERATIONS,
					},
				},
				description: 'Maximum time in milliseconds to wait',
			},
			{
				displayName: 'Timeout',
				name: 'timeoutMs',
				type: 'number',
				default: 60000,
				typeOptions: {
					minValue: 1,
					numberPrecision: 0,
				},
				displayOptions: {
					show: {
						operation: PUBLISH_OPERATIONS,
					},
				},
				description: 'Maximum time in milliseconds to wait for the transaction to publish',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		let credentials;

		try {
			credentials = await this.getCredentials('attoApi');
		} catch {
			// Credentials are optional for local address derivation.
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex, 'address') as AttoResource;
				const defaultOperation = DEFAULT_OPERATION_BY_RESOURCE[resource] ?? 'deriveAddress';
				const operation = this.getNodeParameter('operation', itemIndex, defaultOperation) as AttoOperation;
				const parameters = Object.fromEntries(
					(OPERATION_PARAMETER_NAMES[operation] ?? []).map((name) => [
						name,
						this.getNodeParameter(name, itemIndex, defaultParameterValue(name, operation)) as unknown,
					]),
				);
				if (operation === 'receivePending') parameters.inputItem = items[itemIndex].json;
				const result = await executeAttoOperation(this, operation, parameters, credentials);
				const results = Array.isArray(result) ? result : [result];

				for (const json of results) {
					returnData.push({
						json,
						pairedItem: { item: itemIndex },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error instanceof Error ? error.message : String(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
				nodeError.context.itemIndex = itemIndex;
				throw nodeError;
			}
		}

		return [returnData];
	}
}
