import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';

const { instances } = vi.hoisted(() => ({ instances: [] }));

vi.mock('@browserbasehq/stagehand', async (importOriginal) => {
	const stagehand = await importOriginal();

	return {
		...stagehand,
		Stagehand: class {
			constructor(options) {
				this.options = options;
				instances.push(this);
				this.page = {
					act: async () => {
						options.logger?.({ category: 'act', message: 'Act requested' });
						const completion = await options.llmClient.createChatCompletion({
							options: {
								messages: [{ role: 'user', content: 'click continue' }],
								response_model: {
									name: 'operatorResponseSchema',
									schema: z.object({
										method: z.string(),
										reasoning: z.string(),
										taskComplete: z.boolean(),
										parameters: z.null(),
									}),
								},
							},
							logger: options.logger,
						});
						return { success: true, completion };
					},
					observe: async () => {
						options.logger?.({ category: 'observe', message: 'Observe requested' });
						const completion = await options.llmClient.createChatCompletion({
							options: {
								messages: [{ role: 'user', content: 'find continue' }],
								response_model: {
									name: 'observationSchema',
									schema: z.object({ elements: z.array(z.object({ description: z.string() })) }),
								},
							},
							logger: options.logger,
						});
						return { observations: completion.data.elements, completion };
					},
					extract: async ({ schema }) => {
						const completion = await options.llmClient.createChatCompletion({
							options: {
								messages: [{ role: 'user', content: 'extract page data' }],
								response_model: { name: 'extractionSchema', schema },
							},
							logger: options.logger,
						});
						return completion.data;
					},
				};
			}

			init() {}
			close() {}
		},
	};
});

import { Stagehand } from '../nodes/Stagehand/Stagehand.node';

const actResponse = {
	method: 'close',
	reasoning: 'done',
	taskComplete: true,
	parameters: null,
};
const observeResponse = { elements: [{ description: 'Continue button' }] };

function chatModel(secret, response) {
	const invoke = vi.fn(async () => ({
		parsed: response,
		raw: { usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
	}));
	const bind = vi.fn(() => ({ invoke }));
	const bindTools = vi.fn(() => ({ bind, invoke }));
	const withStructuredOutput = vi.fn(() => ({ bind }));

	return {
		model: {
			apiKey: secret,
			modelName: 'configured-chat-model',
			invoke: vi.fn(),
			bind,
			bindTools,
			withStructuredOutput,
		},
		withStructuredOutput,
		bind,
		invoke,
		bindTools,
	};
}

function extractionContext(model, options = {}) {
	return executionContext('extract', model, {
		schemaSource: 'example',
		exampleJson: '{"title":"Example"}',
		...options,
	});
}

function executionContext(operation, model, options = {}) {
	const parameters = {
		operation,
		cdpUrl: 'ws://localhost:9222',
		instruction: 'interact with the page',
		'options.enableCaching': true,
		'options.logMessages': true,
		'options.verbose': 0,
		...options,
	};

	return {
		getInputData: () => [{ json: {} }],
		getInputConnectionData: async () => model,
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getNode: () => ({ name: 'Stagehand' }),
	};
}

describe('Stagehand connected Chat Model', () => {
	beforeEach(() => instances.splice(0));

	it('uses the connected model for Act, with the default token limit and safe logs', async () => {
		const connected = chatModel('secret-act-token', actResponse);
		const result = await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		const { llmClient } = instances[0].options;

		expect(result[0][0].json.result.completion.data).toEqual(actResponse);
		expect(connected.withStructuredOutput).toHaveBeenCalledWith(
			expect.objectContaining({ _def: expect.any(Object) }),
			{ name: 'operatorResponseSchema', includeRaw: true },
		);
		expect(connected.bind).toHaveBeenCalledWith({ maxTokens: 4096 });
		expect(connected.invoke).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ content: 'click continue' })]),
		);
		expect(llmClient.modelName).toBe('configured-chat-model');
		expect(result[0][0].json.messages).toEqual([{ category: 'act', message: 'Act requested' }]);
		expect(JSON.stringify(result[0][0].json.messages)).not.toContain('secret-act-token');
	});

	it('uses the connected model for Observe and honors the configured token limit', async () => {
		const connected = chatModel('secret-observe-token', observeResponse);
		const result = await Stagehand.prototype.execute.call(
			executionContext('observe', connected.model, { 'options.maxOutputTokens': 1200 }),
		);

		expect(result[0][0].json.result.observations).toEqual(observeResponse.elements);
		expect(connected.withStructuredOutput).toHaveBeenCalledWith(
			expect.objectContaining({ _def: expect.any(Object) }),
			{ name: 'observationSchema', includeRaw: true },
		);
		expect(connected.bind).toHaveBeenCalledWith({ maxTokens: 1200 });
		expect(connected.invoke).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ content: 'find continue' })]),
		);
		expect(result[0][0].json.messages).toEqual([
			{ category: 'observe', message: 'Observe requested' },
		]);
		expect(JSON.stringify(result[0][0].json.messages)).not.toContain('secret-observe-token');
	});

	it('validates connected-model extraction output against the configured Zod schema', async () => {
		const connected = chatModel('secret-extract-token', { title: 'Page title' });
		const result = await Stagehand.prototype.execute.call(extractionContext(connected.model));

		expect(result[0][0].json.result).toEqual({ title: 'Page title' });
		expect(connected.withStructuredOutput).toHaveBeenCalledWith(
			expect.objectContaining({ _def: expect.any(Object) }),
			{ name: 'extractionSchema', includeRaw: true },
		);
	});

	it('reports invalid connected-model extraction output', async () => {
		const connected = chatModel('secret-invalid-token', { title: 42 });
		const result = await Stagehand.prototype.execute.call(extractionContext(connected.model));

		expect(result[0][0].error.message).toContain('structured output');
		expect(result[0][0].error.message).toContain('title');
	});

	it('reports when the connected model lacks structured-output support', async () => {
		const connected = chatModel('secret-unsupported-token', { title: 'Page title' });
		delete connected.model.withStructuredOutput;
		const result = await Stagehand.prototype.execute.call(extractionContext(connected.model));

		expect(result[0][0].error.message).toContain('does not support structured output');
	});

	it('adds Stagehand response context to structured-output parsing failures', async () => {
		const connected = chatModel('secret-parse-token', { title: 'Page title' });
		connected.invoke.mockRejectedValue(new Error('Invalid JSON from model'));
		const result = await Stagehand.prototype.execute.call(extractionContext(connected.model));

		expect(result[0][0].error.message).toContain('extractionSchema');
		expect(result[0][0].error.message).toContain('Invalid JSON from model');
	});

	it('preserves system, assistant, user, and screenshot image content for the connected model', async () => {
		const connected = chatModel('secret-multimodal-token', actResponse);
		const result = await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		const { llmClient } = instances[0].options;

		connected.invoke.mockResolvedValue(new AIMessage('done'));
		await llmClient.createChatCompletion({
			options: {
				messages: [
					{ role: 'system', content: 'Follow the instruction' },
					{ role: 'assistant', content: 'I will inspect the page' },
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'What is shown?' },
							{ type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } },
							{
								type: 'image',
								source: { type: 'base64', media_type: 'image/png', data: 'c2NyZWVuc2hvdA==' },
							},
						],
					},
				],
			},
			logger: vi.fn(),
		});

		const messages = connected.invoke.mock.calls.at(-1)[0];
		expect(messages.map((message) => message.getType())).toEqual(['system', 'ai', 'human']);
		expect(messages[0].content).toBe('Follow the instruction');
		expect(messages[1].content).toBe('I will inspect the page');
		expect(messages[2].content).toEqual([
			{ type: 'text', text: 'What is shown?' },
			{ type: 'image_url', image_url: { url: 'https://example.com/screenshot.png' } },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,c2NyZWVuc2hvdA==' } },
		]);
		expect(result[0][0].error).toBeUndefined();
	});

	it('translates tool calls and omits unavailable usage metadata', async () => {
		const connected = chatModel('secret-tool-token', actResponse);
		await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		const { llmClient } = instances[0].options;
		connected.invoke.mockResolvedValue(
			new AIMessage({
				content: '',
				tool_calls: [{ id: 'call-1', name: 'click', args: { element: 2 } }],
			}),
		);

		const completion = await llmClient.createChatCompletion({
			options: {
				messages: [{ role: 'user', content: 'Click the button' }],
				tools: [{ name: 'click', description: 'Click an element', parameters: { type: 'object' } }],
			},
			logger: vi.fn(),
		});

		expect(connected.bindTools).toHaveBeenCalled();
		expect(completion.choices[0].message.tool_calls).toEqual([
			{
				id: 'call-1',
				type: 'function',
				function: { name: 'click', arguments: '{"element":2}' },
			},
		]);
		expect(completion.choices[0].finish_reason).toBe('tool_calls');
		expect(completion).not.toHaveProperty('usage');
	});

	it('omits structured-response usage when the connected model does not provide it', async () => {
		const connected = chatModel('secret-no-usage-token', actResponse);
		connected.invoke.mockResolvedValue({ parsed: actResponse, raw: {} });

		const result = await Stagehand.prototype.execute.call(executionContext('act', connected.model));

		expect(result[0][0].json.result.completion).not.toHaveProperty('usage');
	});

	it('returns a clear error when tools are requested from a model without tool support', async () => {
		const connected = chatModel('secret-no-tools-token', actResponse);
		await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		const { llmClient } = instances[0].options;
		delete connected.model.bindTools;

		await expect(
			llmClient.createChatCompletion({
				options: {
					messages: [{ role: 'user', content: 'Click the button' }],
					tools: [
						{ name: 'click', description: 'Click an element', parameters: { type: 'object' } },
					],
				},
				logger: vi.fn(),
			}),
		).rejects.toThrow('does not support tool calling required by Stagehand');
	});
});
