import {
	NodeConnectionTypes,
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
	| 'lookupAddress'
	| 'fromAddress'
	| 'destinationAddress'
	| 'amount'
	| 'amountUnit'
	| 'receiveAddress'
	| 'minAmount'
	| 'minAmountUnit'
	| 'receiveRepresentativeAddress'
	| 'timeoutMs'
	| 'changeAddress'
	| 'representativeAddress';

const OPERATION_PARAMETER_NAMES: Record<AttoOperation, readonly AttoParameterName[]> = {
	deriveAccount: ['secretSource', 'walletSecretType', 'walletSecret', 'keyIndex'],
	getAccount: ['lookupAddress'],
	sendTransaction: [
		'secretSource',
		'walletSecretType',
		'walletSecret',
		'keyIndex',
		'fromAddress',
		'destinationAddress',
		'amount',
		'amountUnit',
	],
	receivePending: [
		'secretSource',
		'walletSecretType',
		'walletSecret',
		'keyIndex',
		'receiveAddress',
		'minAmount',
		'minAmountUnit',
		'receiveRepresentativeAddress',
		'timeoutMs',
	],
	changeRepresentative: [
		'secretSource',
		'walletSecretType',
		'walletSecret',
		'keyIndex',
		'changeAddress',
		'representativeAddress',
	],
};

export class Atto implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Atto',
		name: 'atto',
		icon: 'file:atto.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Create accounts and publish Atto transactions using Atto Commons',
		defaults: {
			name: 'Atto',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'attoApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Change Representative',
						value: 'changeRepresentative',
					},
					{
						name: 'Derive Account',
						value: 'deriveAccount',
					},
					{
						name: 'Get Account Info',
						value: 'getAccount',
					},
					{
						name: 'Receive Pending Transaction',
						value: 'receivePending',
					},
					{
						name: 'Send Transaction',
						value: 'sendTransaction',
					},
				],
				default: 'deriveAccount',
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
						operation: [
							'deriveAccount',
							'sendTransaction',
							'receivePending',
							'changeRepresentative',
						],
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
						operation: [
							'deriveAccount',
							'sendTransaction',
							'receivePending',
							'changeRepresentative',
						],
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
						operation: [
							'deriveAccount',
							'sendTransaction',
							'receivePending',
							'changeRepresentative',
						],
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
						operation: [
							'deriveAccount',
							'sendTransaction',
							'receivePending',
							'changeRepresentative',
						],
						secretSource: ['node'],
						walletSecretType: ['mnemonic'],
					},
				},
				description: 'Derivation index used when Wallet Secret Type is Mnemonic Phrase',
			},
			{
				displayName: 'Account Address',
				name: 'lookupAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['getAccount'],
					},
				},
				description: 'Atto account address to look up',
			},
			{
				displayName: 'From Account',
				name: 'fromAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Sender account address. It must match the wallet secret.',
			},
			{
				displayName: 'Destination Account',
				name: 'destinationAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Recipient Atto account address',
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
				options: [
					{
						name: 'ATTO',
						value: 'ATTO',
					},
					{
						name: 'Raw',
						value: 'RAW',
					},
				],
				default: 'ATTO',
				displayOptions: {
					show: {
						operation: ['sendTransaction'],
					},
				},
				description: 'Unit used for Amount',
			},
			{
				displayName: 'Account Address',
				name: 'receiveAddress',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['receivePending'],
					},
				},
				description: 'Account that receives the pending transaction. Leave empty to use the derived address.',
			},
			{
				displayName: 'Minimum Amount',
				name: 'minAmount',
				type: 'string',
				default: '1',
				displayOptions: {
					show: {
						operation: ['receivePending'],
					},
				},
				description: 'Smallest receivable amount to accept',
			},
			{
				displayName: 'Minimum Amount Unit',
				name: 'minAmountUnit',
				type: 'options',
				options: [
					{
						name: 'ATTO',
						value: 'ATTO',
					},
					{
						name: 'Raw',
						value: 'RAW',
					},
				],
				default: 'RAW',
				displayOptions: {
					show: {
						operation: ['receivePending'],
					},
				},
				description: 'Unit used for Minimum Amount',
			},
			{
				displayName: 'Representative Account',
				name: 'receiveRepresentativeAddress',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['receivePending'],
					},
				},
				description: 'Representative for opening a new receiving account. Leave empty to use the account itself.',
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
						operation: ['receivePending'],
					},
				},
				description: 'Maximum time in milliseconds to wait for a pending transaction',
			},
			{
				displayName: 'Account Address',
				name: 'changeAddress',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['changeRepresentative'],
					},
				},
				description: 'Account whose representative changes. Leave empty to use the derived address.',
			},
			{
				displayName: 'Representative Account',
				name: 'representativeAddress',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['changeRepresentative'],
					},
				},
				description: 'New representative account address',
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
			// Credentials are optional for local account derivation.
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as AttoOperation;
				const parameters = Object.fromEntries(
					OPERATION_PARAMETER_NAMES[operation].map((name) => [
						name,
						this.getNodeParameter(name, itemIndex, undefined) as unknown,
					]),
				);
				const result = await executeAttoOperation(operation, parameters, credentials);

				returnData.push({
					json: result,
					pairedItem: { item: itemIndex },
				});
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

				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}
