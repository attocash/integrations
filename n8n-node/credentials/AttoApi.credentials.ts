import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AttoApi implements ICredentialType {
	name = 'attoApi';

	displayName = 'Atto API';

	icon: Icon = 'file:../nodes/Atto/atto.svg';

	documentationUrl = 'https://github.com/attocash/integrations/tree/main/n8n-node#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Node Base URL',
			name: 'nodeUrl',
			type: 'string',
			default: 'https://gatekeeper.live.application.atto.cash',
			placeholder: 'https://my-node.example',
			description: 'Base URL of the Atto node HTTP API',
		},
		{
			displayName: 'Worker Base URL',
			name: 'workerUrl',
			type: 'string',
			default: 'https://gatekeeper.live.application.atto.cash',
			placeholder: 'https://my-work-server.example',
			description: 'Base URL of the Atto work server HTTP API',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Optional API key sent to both Atto node and worker requests',
		},
		{
			displayName: 'API Key Header',
			name: 'authHeaderName',
			type: 'string',
			default: 'Authorization',
			displayOptions: {
				hide: {
					apiKey: [''],
				},
			},
			description: 'Header name used when API Key is set',
		},
		{
			displayName: 'API Key Prefix',
			name: 'authHeaderPrefix',
			type: 'string',
			default: 'Bearer',
			displayOptions: {
				hide: {
					apiKey: [''],
				},
			},
			description: 'Optional prefix placed before the API key, for example Bearer',
		},
		{
			displayName: 'Wallet Secret Type',
			name: 'walletMaterialType',
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
			description: 'Secret format used for signing Atto transactions',
		},
		{
			displayName: 'Wallet Secret',
			name: 'walletSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Mnemonic phrase or private key. It is used only for signing and is never returned by this node.',
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
					walletMaterialType: ['mnemonic'],
				},
			},
			description: 'Derivation index used when Wallet Secret Type is Mnemonic Phrase',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.nodeUrl}}',
			url: '/health',
			method: 'GET',
		},
	};
}
