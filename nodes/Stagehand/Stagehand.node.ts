import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { assert, NodeOperationError, UserError } from 'n8n-workflow';
import type { ClientLLM } from '@browserbasehq/stagehand' with { 'resolution-mode': 'import' };
import { z, ZodTypeAny } from 'zod-v4';
import jsonToZod from 'json-to-zod';
import jsonSchemaToZod from 'json-schema-to-zod';

type Field = {
	fieldName: string;
	fieldType: string;
	optional: boolean;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Adapts Stagehand's model callback to the Chat Model connected in n8n. */
function createConnectedChatModel(model: BaseChatModel, maxOutputTokens: number): ClientLLM {
	return {
		async generate(request) {
			const messages = request.messages.map(({ role, content }) => {
				const parts = Array.isArray(content) ? content : [content];
				const mappedContent = parts.map((part) => {
					if (part.type === 'text') return { type: 'text' as const, text: part.text };
					if (part.type === 'image') {
						return {
							type: 'image_url' as const,
							image_url: { url: `data:${part.mimeType};base64,${part.data}` },
						};
					}
					if (part.type === 'tool_use') {
						return { type: 'text' as const, text: JSON.stringify(part.input) };
					}
					return {
						type: 'text' as const,
						text: part.content.map((item) => (item.type === 'text' ? item.text : '')).join(''),
					};
				});

				return role === 'assistant'
					? new AIMessage({ content: mappedContent as never })
					: new HumanMessage({ content: mappedContent as never });
			});

			let connectedModel = model;
			if ('tools' in request && request.tools?.length && !connectedModel.bindTools) {
				throw new UserError(
					'The connected Chat Model does not support tool calling required by Stagehand',
				);
			}
			if ('tools' in request && request.tools?.length && connectedModel.bindTools) {
				connectedModel = connectedModel.bindTools(
					request.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.inputSchema,
					})),
					{ tool_choice: 'toolChoice' in request ? (request.toolChoice?.mode ?? 'auto') : 'auto' },
				) as BaseChatModel;
			}

			const invokeOptions = { maxTokens: maxOutputTokens } as never;
			const usageFrom = (response: unknown) => {
				const usage = response instanceof AIMessage ? response.usage_metadata : undefined;
				return usage
					? {
							inputTokens: usage.input_tokens,
							outputTokens: usage.output_tokens,
							totalTokens: usage.total_tokens,
						}
					: undefined;
			};

			if ('responseFormat' in request && request.responseFormat?.type === 'json_schema') {
				const responseFormat = request.responseFormat;
				if (typeof connectedModel.withStructuredOutput !== 'function') {
					throw new UserError(
						'The connected Chat Model does not support structured output required by Stagehand',
					);
				}
				try {
					const schema = new Function(
						'z',
						`return ${jsonSchemaToZod(responseFormat.schema as never)};`,
					)(z);
					const structured = (await connectedModel
						.withStructuredOutput(schema, { name: responseFormat.name, includeRaw: true })
						.invoke(messages, invokeOptions)) as { parsed: unknown; raw: unknown };
					if (
						!structured.parsed ||
						typeof structured.parsed !== 'object' ||
						Array.isArray(structured.parsed)
					) {
						throw new UserError('The connected Chat Model returned a non-object response');
					}
					return {
						role: 'assistant' as const,
						content: [],
						outputFormat: 'json_schema' as const,
						structuredContent: structured.parsed as never,
						...(usageFrom(structured.raw) ? { usage: usageFrom(structured.raw) } : {}),
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new UserError(
						`The connected Chat Model failed to produce structured output for Stagehand response "${responseFormat.name}": ${message}`,
					);
				}
			}

			const response = await connectedModel.invoke(messages, invokeOptions);
			const responseText =
				typeof response.content === 'string'
					? response.content
					: response.content
							.map((part) => (typeof part === 'string' ? part : 'text' in part ? part.text : ''))
							.join('');
			const toolCalls = response instanceof AIMessage ? (response.tool_calls ?? []) : [];
			const content = [
				...(responseText ? [{ type: 'text' as const, text: responseText }] : []),
				...toolCalls.map((call, index) => ({
					type: 'tool_use' as const,
					id: call.id ?? `call_${index}`,
					name: call.name,
					input: call.args,
				})),
			];
			return {
				role: 'assistant' as const,
				content,
				outputFormat: 'text' as const,
				...(usageFrom(response) ? { usage: usageFrom(response) } : {}),
			};
		},
	};
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
			'main',
			{
				displayName: 'Model',
				maxConnections: 1,
				type: 'ai_languageModel',
				required: false,
			},
		],
		outputs: ['main'],
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
		const model = await this.getInputConnectionData('ai_languageModel', 0);

		assert(Stagehand.isChatInstance(model), 'A Chat Model is required');
		const { Stagehand: StagehandCore, localBrowser } = await import('@browserbasehq/stagehand');

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

			const messages: IDataObject[] = [];
			const browser = await localBrowser.connect({ cdpUrl });
			let stagehand: Awaited<ReturnType<typeof StagehandCore.create>> | undefined;

			try {
				stagehand = await StagehandCore.create({
					browser,
					cache: enableCaching,
					model: createConnectedChatModel(model, maxOutputTokens),
					logging: {
						level: verbose === 0 ? 'error' : verbose === 1 ? 'info' : 'debug',
						onLog: logMessages
							? (message) => {
									messages.push(message as unknown as IDataObject);
								}
							: undefined,
					},
				});
				const page = await browser.context.activePage();
				if (!page) throw new UserError('The connected browser has no active page');

				switch (operation) {
					case 'act': {
						const instruction = this.getNodeParameter('instruction', i, '') as string;

						results.push({
							json: {
								operation,
								result: await stagehand.act(instruction, { page }),
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
								throw new UserError(`Unsupported schema source: ${schemaSource}`);
							}
						}

						results.push({
							json: {
								operation,
								result: (await stagehand.extract(instruction, schema as never, { page }))
									.data as IDataObject,
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
								result: await stagehand.observe(instruction, { page }),
								...(logMessages ? { messages } : {}),
							},
						});
						break;
					}

					default: {
						throw new UserError(`Unsupported operation: ${operation}`);
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
				if (stagehand) await stagehand.close();
				await browser.disconnect();
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
