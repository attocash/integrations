import {
	NodeConnectionTypes,
	NodeApiError,
	NodeOperationError,
	type INodeType,
	type INodeTypeDescription,
	type ITriggerFunctions,
	type ITriggerResponse,
} from 'n8n-workflow';
import {
	startAttoEventStream,
	type AttoParameters,
	type AttoTriggerEvent,
} from '../Atto/operations';

const TRIGGER_PARAMETER_NAMES = [
	'addressSource',
	'addresses',
	'queryMode',
	'hash',
	'fromHeight',
	'toHeight',
	'minAmount',
	'minAmountUnit',
] as const;

type AttoTriggerParameterName = (typeof TRIGGER_PARAMETER_NAMES)[number];

const TRIGGER_PARAMETER_DEFAULTS: Record<AttoTriggerParameterName, string> = {
	addressSource: 'credentials',
	addresses: '',
	queryMode: 'credentials',
	hash: '',
	fromHeight: '',
	toHeight: '',
	minAmount: '1',
	minAmountUnit: 'RAW',
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

export class AttoTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Atto Trigger',
		name: 'attoTrigger',
		icon: {
			light: 'file:atto.svg',
			dark: 'file:atto.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Trigger workflows from Atto receivables, account updates, transactions, and account entries',
		defaults: {
			name: 'Atto Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'attoApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Account Entry',
						value: 'accountEntry',
					},
					{
						name: 'Account Update',
						value: 'account',
					},
					{
						name: 'Receivable',
						value: 'receivable',
					},
					{
						name: 'Transaction',
						value: 'transaction',
					},
				],
				default: 'receivable',
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
						event: ['receivable'],
					},
				},
				description: 'Where receivable addresses come from',
			},
			{
				displayName: 'Address Source',
				name: 'addressSource',
				type: 'options',
				options: [
					{
						name: 'All',
						value: 'all',
					},
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
						event: ['account'],
					},
				},
				description: 'Where account update addresses come from',
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
						event: ['transaction', 'accountEntry'],
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
						event: ['receivable', 'account'],
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
						event: ['transaction', 'accountEntry'],
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
						event: ['transaction', 'accountEntry'],
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
						event: ['transaction', 'accountEntry'],
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
						event: ['transaction', 'accountEntry'],
						queryMode: ['credentials', 'manual'],
					},
				},
				description: 'Optional last account height to include',
			},
			{
				displayName: 'Minimum Amount',
				name: 'minAmount',
				type: 'string',
				default: '1',
				displayOptions: {
					show: {
						event: ['receivable'],
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
						event: ['receivable'],
					},
				},
				description: 'Unit used for Minimum Amount',
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		try {
			const credentials = await this.getCredentials('attoApi');
			const event = this.getNodeParameter('event', 'receivable') as AttoTriggerEvent;
			const parameters = Object.fromEntries(
				TRIGGER_PARAMETER_NAMES.map((name) => [
					name,
					this.getNodeParameter(name, TRIGGER_PARAMETER_DEFAULTS[name]) as unknown,
				]),
			) as AttoParameters;
			const stream = await startAttoEventStream(
				this,
				event,
				parameters,
				credentials,
				(json) => this.emit([[{ json }]]),
			);
			return {
				closeFunction: async () => stream.close(),
			};
		} catch (error) {
			const nodeError =
				error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error);
			throw nodeError;
		}
	}
}
