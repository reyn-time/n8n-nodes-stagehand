import { beforeEach, describe, expect, it, vi } from 'vitest';

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
								response_model: { name: 'operatorResponseSchema', schema: {} },
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
								response_model: { name: 'observationSchema', schema: {} },
							},
							logger: options.logger,
						});
						return { observations: completion.data.elements, completion };
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
	const withStructuredOutput = vi.fn(() => ({ bind }));

	return {
		model: {
			apiKey: secret,
			modelName: 'configured-chat-model',
			invoke: vi.fn(),
			withStructuredOutput,
		},
		withStructuredOutput,
		bind,
		invoke,
	};
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
			{},
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
			{},
			{ name: 'observationSchema', includeRaw: true },
		);
		expect(connected.bind).toHaveBeenCalledWith({ maxTokens: 1200 });
		expect(connected.invoke).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ content: 'find continue' })]),
		);
		expect(result[0][0].json.messages).toEqual([{ category: 'observe', message: 'Observe requested' }]);
		expect(JSON.stringify(result[0][0].json.messages)).not.toContain('secret-observe-token');
	});
});
