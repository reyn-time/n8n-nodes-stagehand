import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, assert, NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import {
	CreateChatCompletionOptions,
	LLMClient,
	LLMResponse,
	LogLine,
	Stagehand as StagehandCore,
} from '@browserbasehq/stagehand';
import { z, ZodTypeAny } from 'zod';
import jsonToZod from 'json-to-zod';
import jsonSchemaToZod from 'json-schema-to-zod';

type Field = {
	fieldName: string;
	fieldType: string;
	optional: boolean;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function getConnectedModelName(model: BaseChatModel): string {
	const modelWithIdentity = model as BaseChatModel & { model?: unknown; modelName?: unknown };
	const modelName = modelWithIdentity.modelName ?? modelWithIdentity.model;

	return typeof modelName === 'string' && modelName.length > 0 ? modelName : 'connected-chat-model';
}

/** Adapts Stagehand's completion requests to the Chat Model connected in n8n. */
class ConnectedChatModelClient extends LLMClient {
	type = 'n8nChatModel';

	constructor(
		private readonly model: BaseChatModel,
		private readonly maxOutputTokens: number,
	) {
		super(getConnectedModelName(model));
	}

	async createChatCompletion<T = LLMResponse>({
		options,
	}: CreateChatCompletionOptions): Promise<T> {
		const messages = options.messages.map(({ role, content }) => {
			const mappedContent =
				typeof content === 'string'
					? content
					: content.map((part) => {
							if (part.type === 'text') return { type: 'text' as const, text: part.text ?? '' };
							if ('image_url' in part && part.image_url?.url) {
								return { type: 'image_url' as const, image_url: part.image_url.url };
							}
							if ('source' in part && part.source?.data) {
								return {
									type: 'image_url' as const,
									image_url: `data:${part.source.media_type};base64,${part.source.data}`,
								};
							}
							return { type: 'text' as const, text: part.text ?? '' };
						});

			switch (role) {
				case 'system':
					return new SystemMessage(mappedContent as never);
				case 'assistant':
					return new AIMessage(mappedContent as never);
				default:
					return new HumanMessage(mappedContent as never);
			}
		});

		let model = this.model;
		if (options.tools?.length && model.bindTools) {
			model = model.bindTools(
				options.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
				{ tool_choice: options.tool_choice },
			) as BaseChatModel;
		}

		const maxTokens = options.maxTokens ?? this.maxOutputTokens;
		if (options.response_model) {
			if (typeof model.withStructuredOutput !== 'function') {
				throw new ApplicationError(
					'The connected Chat Model does not support structured output required by Stagehand',
				);
			}
			let structuredResponse: unknown;
			try {
				const structuredModel = model
					.withStructuredOutput(options.response_model.schema, {
						name: options.response_model.name,
						includeRaw: true,
					})
					.bind({ maxTokens } as never);
				structuredResponse = await structuredModel.invoke(messages);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ApplicationError(
					`The connected Chat Model failed to produce structured output for Stagehand response "${options.response_model.name}": ${message}`,
				);
			}
			const { parsed: data, raw } = structuredResponse as {
				parsed: unknown;
				raw: {
					usage_metadata?: { input_tokens: number; output_tokens: number; total_tokens: number };
				};
			};
			const validation = options.response_model.schema.safeParse(data);
			if (!validation.success) {
				throw new ApplicationError(
					`The connected Chat Model returned invalid structured output for Stagehand response "${options.response_model.name}": ${validation.error.message}`,
				);
			}
			const usage = raw.usage_metadata;
			return {
				data: validation.data,
				usage: {
					prompt_tokens: usage?.input_tokens ?? 0,
					completion_tokens: usage?.output_tokens ?? 0,
					total_tokens: usage?.total_tokens ?? 0,
				},
			} as T;
		}

		const response = await model.bind({ maxTokens } as never).invoke(messages);
		const responseText =
			typeof response.content === 'string'
				? response.content
				: response.content
						.map((part) => (typeof part === 'string' ? part : 'text' in part ? part.text : ''))
						.join('');
		const toolCalls = response instanceof AIMessage ? (response.tool_calls ?? []) : [];
		const usage = response instanceof AIMessage ? response.usage_metadata : undefined;

		return {
			id: response.id ?? 'n8n-chat-model-response',
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: this.modelName,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: responseText || null,
						tool_calls: toolCalls.map((call, index) => ({
							id: call.id ?? `call_${index}`,
							type: 'function',
							function: { name: call.name, arguments: JSON.stringify(call.args) },
						})),
					},
					finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
				},
			],
			usage: {
				prompt_tokens: usage?.input_tokens ?? 0,
				completion_tokens: usage?.output_tokens ?? 0,
				total_tokens: usage?.total_tokens ?? 0,
			},
		} as T;
	}
}

export class Stagehand implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Stagehand',
		name: 'stagehand',
		icon: 'file:stagehand.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Control browser using Stagehand with CDP URL',
		defaults: {
			name: 'Stagehand',
		},
		inputs: [
			NodeConnectionType.Main,
			{
				displayName: 'Model',
				maxConnections: 1,
				type: NodeConnectionType.AiLanguageModel,
				required: false,
			},
		],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				options: [
					{
						name: 'Act',
						value: 'act',
						description: 'Execute an action on the page using natural language',
						action: 'Execute an action on the page',
					},
					{
						name: 'Extract',
						value: 'extract',
						description: 'Extract structured data from the page',
						action: 'Extract data from the page',
					},
					{
						name: 'Observe',
						value: 'observe',
						description: 'Observe the page and plan an action',
						action: 'Observe the page',
					},
				],
				default: 'act',
			},
			{
				displayName: 'CDP URL',
				name: 'cdpUrl',
				type: 'string',
				default: '',
				placeholder: 'ws://localhost:9222/devtools/browser/...',
				description: 'Chrome DevTools Protocol URL to connect to the browser',
				required: true,
			},
			{
				displayName: 'Instruction',
				name: 'instruction',
				type: 'string',
				default: '',
				description: 'Instruction for the Stagehand to perform',
				required: true,
			},
			{
				displayName: 'Schema Source',
				name: 'schemaSource',
				type: 'options',
				options: [
					{
						name: 'Field List',
						value: 'fieldList',
					},
					{
						name: 'Example JSON',
						value: 'example',
					},
					{
						name: 'JSON Schema',
						value: 'jsonSchema',
					},
					{
						name: 'Manual Zod',
						value: 'manual',
					},
				],
				displayOptions: {
					show: {
						operation: ['extract'],
					},
				},
				default: 'fieldList',
				required: true,
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Field',
					minRequiredFields: 1,
				},
				default: [],
				description: 'List of output fields and their types',
				options: [
					{
						displayName: 'Field',
						name: 'field',
						values: [
							{
								displayName: 'Name',
								name: 'fieldName',
								type: 'string',
								default: '',
								description: 'Property name in the extracted object',
								required: true,
							},
							{
								displayName: 'Type',
								name: 'fieldType',
								type: 'options',
								options: [
									{
										name: 'Array',
										value: 'array',
									},
									{
										name: 'Boolean',
										value: 'boolean',
									},
									{
										name: 'Number',
										value: 'number',
									},
									{
										name: 'Object',
										value: 'object',
									},
									{
										name: 'String',
										value: 'string',
									},
								],
								default: 'string',
								required: true,
							},
							{
								displayName: 'Optional',
								name: 'optional',
								type: 'boolean',
								default: false,
								required: true,
							},
						],
					},
				],
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['fieldList'],
					},
				},
			},
			{
				displayName: 'Example JSON',
				name: 'exampleJson',
				type: 'json',
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['example'],
					},
				},
				default: '{\n  "title": "My Title",\n  "description": "My Description"\n}',
				required: true,
			},
			{
				displayName: 'JSON Schema',
				name: 'jsonSchema',
				type: 'json',
				typeOptions: {
					rows: 6,
				},
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['jsonSchema'],
					},
				},
				default:
					'{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "object",\n  "properties": {\n    "title": { "type": "string", "description": "The page title" },\n    "description": { "type": "string", "description": "The page description" }\n  },\n  "required": ["title", "description"]\n}',
				required: true,
			},
			{
				displayName: 'Zod Code',
				name: 'manualZod',
				type: 'string',
				typeOptions: { rows: 6 },
				displayOptions: {
					show: {
						operation: ['extract'],
						schemaSource: ['manual'],
					},
				},
				default:
					'z.object({\n  title: z.string().describe("The page title"),\n  description: z.string().describe("The page description")\n})',
				required: true,
			},
			// ADVANCED OPTIONS
			{
				displayName: 'Advanced Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				description: 'Advanced options for Stagehand',
				options: [
					{
						displayName: 'Maximum Output Tokens',
						name: 'maxOutputTokens',
						type: 'number',
						default: DEFAULT_MAX_OUTPUT_TOKENS,
						typeOptions: { minValue: 1 },
						description:
							'Maximum number of tokens the connected Chat Model can generate per response',
					},
					{
						displayName: 'Enable Caching',
						name: 'enableCaching',
						type: 'boolean',
						default: true,
						description: 'Whether to enable caching for Stagehand operations',
					},
					{
						displayName: 'Log Messages',
						name: 'logMessages',
						type: 'boolean',
						default: false,
						description: 'Whether to include Stagehand log messages in the node output',
					},
					{
						displayName: 'Verbose Level',
						name: 'verbose',
						type: 'options',
						options: [
							{
								name: 'No Logs',
								value: 0,
							},
							{
								name: 'Only Errors',
								value: 1,
							},
							{
								name: 'All Logs',
								value: 2,
							},
						],
						default: 0,
						description: 'Level of verbosity for Stagehand internal logging',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const model = await this.getInputConnectionData(NodeConnectionType.AiLanguageModel, 0);

		assert(Stagehand.isChatInstance(model), 'A Chat Model is required');

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const cdpUrl = this.getNodeParameter('cdpUrl', i, '') as string;
			const enableCaching = this.getNodeParameter('options.enableCaching', i, true) as boolean;
			const logMessages = this.getNodeParameter('options.logMessages', i, false) as boolean;
			const verbose = this.getNodeParameter('options.verbose', i, 0) as 0 | 1 | 2;
			const maxOutputTokens = this.getNodeParameter(
				'options.maxOutputTokens',
				i,
				DEFAULT_MAX_OUTPUT_TOKENS,
			) as number;

			const messages: LogLine[] = [];
			const stagehand = new StagehandCore({
				env: 'LOCAL',
				enableCaching,
				verbose,
				logger: logMessages
					? (message) => {
							messages.push(message);
						}
					: undefined,
				llmClient: new ConnectedChatModelClient(model, maxOutputTokens),
				localBrowserLaunchOptions: {
					cdpUrl,
				},
			});
			await stagehand.init();

			try {
				switch (operation) {
					case 'act': {
						const instruction = this.getNodeParameter('instruction', i, '') as string;

						results.push({
							json: {
								operation,
								result: await stagehand.page.act(instruction),
								...(logMessages ? { messages } : {}),
							},
						});
						break;
					}

					case 'extract': {
						const instruction = this.getNodeParameter('instruction', i, '') as string;
						const schemaSource = this.getNodeParameter('schemaSource', i, 'example') as string;

						let schema: z.ZodObject<any>;
						switch (schemaSource) {
							case 'fieldList': {
								const fields = this.getNodeParameter('fields.field', i, []) as any[];
								schema = Stagehand.fieldsToZodSchema(fields);
								break;
							}

							case 'example': {
								const example = this.getNodeParameter('exampleJson', i) as string;
								schema = new Function('z', `${jsonToZod(JSON.parse(example))}return schema;`)(z);
								break;
							}

							case 'jsonSchema': {
								const jsonSchema = this.getNodeParameter('jsonSchema', i) as string;
								schema = new Function('z', `return ${jsonSchemaToZod(JSON.parse(jsonSchema))};`)(z);
								break;
							}

							case 'manual': {
								const zodCode = this.getNodeParameter('manualZod', i) as string;
								schema = new Function('z', `return ${zodCode};`)(z);
								break;
							}

							default: {
								throw new ApplicationError(`Unsupported schema source: ${schemaSource}`);
							}
						}

						results.push({
							json: {
								operation,
								result: await stagehand.page.extract({
									instruction,
									schema,
								}),
								...(logMessages ? { messages } : {}),
							},
						});
						break;
					}

					case 'observe': {
						const instruction = this.getNodeParameter('instruction', i, '') as string;

						results.push({
							json: {
								operation,
								result: await stagehand.page.observe({
									instruction,
								}),
								...(logMessages ? { messages } : {}),
							},
						});
						break;
					}

					default: {
						throw new ApplicationError(`Unsupported operation: ${operation}`);
					}
				}
			} catch (error) {
				results.push({
					error: new NodeOperationError(this.getNode(), error as Error, {
						message: `Error executing Stagehand operation: ${error.message}`,
					}),
					json: {
						operation,
						...(logMessages ? { messages } : {}),
					},
				});
			} finally {
				await stagehand.close();
			}
		}

		return [results];
	}

	static isChatInstance(model: unknown): model is BaseChatModel {
		return !!model && typeof (model as BaseChatModel).invoke === 'function';
	}

	static fieldsToZodSchema(fields: Field[]): z.ZodObject<any> {
		const shape: Record<string, ZodTypeAny> = {};

		for (const { fieldName, fieldType, optional } of fields) {
			let zType: ZodTypeAny;

			switch (fieldType) {
				case 'string':
					zType = z.string();
					break;
				case 'number':
					zType = z.number();
					break;
				case 'boolean':
					zType = z.boolean();
					break;
				case 'array':
					zType = z.array(z.any());
					break; // puoi espandere
				case 'object':
					zType = z.object({}).passthrough();
					break;
				default:
					zType = z.any();
			}

			shape[fieldName] = optional ? zType.optional() : zType;
		}

		return z.object(shape);
	}
}
