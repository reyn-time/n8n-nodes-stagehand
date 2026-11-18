const assert = require('node:assert/strict');
const test = require('node:test');

const Module = require('node:module');
const stagehandInstances = [];

class MockStagehand {
	constructor(options) {
		this.options = options;
		this.page = {
			act: async () => {
				this.options.logger?.({ category: 'act', message: 'Act requested' });
				const completion = await this.options.llmClient.createChatCompletion({
					options: {
						messages: [{ role: 'user', content: 'click continue' }],
						response_model: { name: 'operatorResponseSchema', schema: {} },
					},
					logger: this.options.logger ?? (() => {}),
				});
				return { success: true, completion };
			},
			observe: async () => {
				this.options.logger?.({ category: 'observe', message: 'Observe requested' });
				const completion = await this.options.llmClient.createChatCompletion({
					options: {
						messages: [{ role: 'user', content: 'find continue' }],
						response_model: { name: 'observationSchema', schema: {} },
					},
					logger: this.options.logger ?? (() => {}),
				});
				return { observations: completion.data.elements, completion };
			},
		};
		stagehandInstances.push(this);
	}

	async init() {}
	async close() {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === '@browserbasehq/stagehand') {
		return { ...originalLoad.call(this, request, parent, isMain), Stagehand: MockStagehand };
	}
	return originalLoad.call(this, request, parent, isMain);
};
const { Stagehand } = require('../dist/nodes/Stagehand/Stagehand.node.js');
Module._load = originalLoad;

function createContext(operation, chatModel, extraParameters = {}) {
	const parameters = {
		operation,
		cdpUrl: 'ws://localhost:9222',
		instruction: 'interact with the page',
		'options.enableCaching': true,
		'options.logMessages': true,
		'options.verbose': 0,
		...extraParameters,
	};

	return {
		getInputData: () => [{ json: {} }],
		getInputConnectionData: async () => chatModel,
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getNode: () => ({ name: 'Stagehand' }),
	};
}

function createChatModel(secret) {
	const calls = [];
	const model = {
		apiKey: secret,
		modelName: 'configured-chat-model',
		invoke: async () => { throw new Error('Expected bind() before invoke()'); },
		bind(options) {
			calls.push(options);
			return {
				invoke: async (messages) => {
					calls.push(messages);
					return { content: 'model response', id: 'response-1' };
				},
			};
		},
		withStructuredOutput(schema, options) {
			calls.push({ schema, ...options });
			const parsed = options.name === 'observationSchema'
				? { elements: [{ description: 'Continue button' }] }
				: { method: 'close', reasoning: 'done', taskComplete: true, parameters: null };
			return {
				bind: (bindOptions) => {
					calls.push(bindOptions);
					return {
						invoke: async (messages) => {
							calls.push(messages);
							return {
								parsed,
								raw: { usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
							};
						},
					};
				},
			};
		},
	};
	return { model, calls };
}

test('Act delegates inference to the connected Chat Model with the default token limit', async () => {
	stagehandInstances.length = 0;
	const { model, calls } = createChatModel('secret-act-token');
	const result = await Stagehand.prototype.execute.call(createContext('act', model));

	assert.equal(result[0][0].json.result.success, true);
	assert.deepEqual(calls[0], { schema: {}, name: 'operatorResponseSchema', includeRaw: true });
	assert.deepEqual(calls[1], { maxTokens: 4096 });
	assert.equal(calls[2][0].content, 'click continue');
	assert.equal(stagehandInstances[0].options.llmClient.modelName, 'configured-chat-model');
	assert.deepEqual(result[0][0].json.result.completion.data, {
		method: 'close',
		reasoning: 'done',
		taskComplete: true,
		parameters: null,
	});
	assert.deepEqual(result[0][0].json.result.completion.usage, {
		prompt_tokens: 10,
		completion_tokens: 20,
		total_tokens: 30,
	});
	assert.equal(stagehandInstances[0].options.llmClient.type, 'n8nChatModel');
	assert.equal('modelClientOptions' in stagehandInstances[0].options, false);
	assert.deepEqual(result[0][0].json.messages, [{ category: 'act', message: 'Act requested' }]);
	assert.equal(JSON.stringify(result[0][0].json.messages).includes('secret-act-token'), false);
});

test('Observe delegates inference to the connected Chat Model and honors the configured token limit', async () => {
	stagehandInstances.length = 0;
	const { model, calls } = createChatModel('secret-observe-token');
	const result = await Stagehand.prototype.execute.call(
		createContext('observe', model, { 'options.maxOutputTokens': 1200 }),
	);

	assert.deepEqual(result[0][0].json.result.observations, [{ description: 'Continue button' }]);
	assert.deepEqual(calls[0], { schema: {}, name: 'observationSchema', includeRaw: true });
	assert.deepEqual(calls[1], { maxTokens: 1200 });
	assert.equal(calls[2][0].content, 'find continue');
	assert.deepEqual(result[0][0].json.messages, [{ category: 'observe', message: 'Observe requested' }]);
	assert.equal(JSON.stringify(result[0][0].json.messages).includes('secret-observe-token'), false);
});
