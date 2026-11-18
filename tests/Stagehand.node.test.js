import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod-v4';

const { instances, stagehandCreate, browserConnect, browserDisconnect } = vi.hoisted(() => {
	const instances = [];
	const browserDisconnect = vi.fn();
	const page = {};
	const browser = {
		context: { activePage: vi.fn(async () => page) },
		disconnect: browserDisconnect,
	};
	const browserConnect = vi.fn(async () => browser);
	const stagehandCreate = vi.fn(async (options) => {
		instances.push({ options });
		const generateStructured = async (name, schema, text) => {
			const output = await options.model.generate({
				messages: [{ role: 'user', content: [{ type: 'text', text }] }],
				responseFormat: { type: 'json_schema', name, schema },
			});
			return output.structuredContent;
		};
		return {
			act: async (instruction) => {
				options.logging.onLog?.({ level: 'info', message: 'Act requested', data: {} });
				const result = await generateStructured(
					'actResult',
					{
						type: 'object',
						properties: { instruction: { type: 'string' } },
						required: ['instruction'],
					},
					instruction,
				);
				return { instruction: result.instruction };
			},
			observe: async (instruction) => {
				options.logging.onLog?.({ level: 'info', message: 'Observe requested', data: {} });
				return generateStructured(
					'observeResult',
					{
						type: 'object',
						properties: { instruction: { type: 'string' } },
						required: ['instruction'],
					},
					instruction ?? '',
				);
			},
			extract: async (instruction, schema) => {
				const result = await generateStructured(
					'extractResult',
					z.toJSONSchema(schema),
					instruction,
				);
				return { data: result };
			},
			close: vi.fn(),
		};
	});
	return { instances, stagehandCreate, browserConnect, browserDisconnect };
});

vi.mock('@browserbasehq/stagehand', () => ({
	Stagehand: { create: stagehandCreate },
	localBrowser: { connect: browserConnect },
}));

import { Stagehand } from '../nodes/Stagehand/Stagehand.node';

function chatModel(response) {
	const structuredInvoke = vi.fn(async () => ({
		parsed: response,
		raw: new AIMessage({
			content: '',
			usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		}),
	}));
	const invoke = vi.fn(async () => new AIMessage('response text'));
	const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
	const bindTools = vi.fn(() => ({ invoke }));
	return {
		model: { modelName: 'connected-chat-model', invoke, withStructuredOutput, bindTools },
		invoke,
		structuredInvoke,
		withStructuredOutput,
		bindTools,
	};
}

function executionContext(operation, model, options = {}) {
	const parameters = {
		operation,
		cdpUrl: 'ws://localhost:9222',
		instruction: 'click continue',
		'options.enableCaching': true,
		'options.logMessages': true,
		'options.verbose': 1,
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
	beforeEach(() => {
		instances.splice(0);
		stagehandCreate.mockClear();
		browserConnect.mockClear();
		browserDisconnect.mockClear();
	});

	it('uses the connected model for Act and reports logs without exposing credentials', async () => {
		const connected = chatModel({ instruction: 'click continue' });
		const result = await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		const options = instances[0].options;

		expect(result[0][0].json.result).toEqual({ instruction: 'click continue' });
		expect(options.cache).toBe(true);
		expect(options.model).toBeDefined();
		expect(connected.withStructuredOutput).toHaveBeenCalledWith(expect.any(Object), {
			name: 'actResult',
			includeRaw: true,
		});
		expect(connected.structuredInvoke).toHaveBeenCalledWith(expect.any(Array), { maxTokens: 4096 });
		expect(result[0][0].json.messages).toEqual([
			{ level: 'info', message: 'Act requested', data: {} },
		]);
		expect(browserConnect).toHaveBeenCalledWith({ cdpUrl: 'ws://localhost:9222' });
		expect(browserDisconnect).toHaveBeenCalledOnce();
	});

	it('uses the connected model for Observe and honors the token limit', async () => {
		const connected = chatModel({ instruction: 'find continue' });
		const result = await Stagehand.prototype.execute.call(
			executionContext('observe', connected.model, {
				'options.maxOutputTokens': 1200,
			}),
		);

		expect(result[0][0].json.result).toEqual({ instruction: 'find continue' });
		expect(connected.structuredInvoke).toHaveBeenCalledWith(expect.any(Array), { maxTokens: 1200 });
		expect(result[0][0].json.messages).toEqual([
			{ level: 'info', message: 'Observe requested', data: {} },
		]);
	});

	it('validates extraction output through the connected model schema boundary', async () => {
		const connected = chatModel({ title: 'Page title' });
		const context = executionContext('extract', connected.model, {
			schemaSource: 'example',
			exampleJson: '{"title":"Example"}',
		});
		const result = await Stagehand.prototype.execute.call(context);

		expect(result[0][0].json.result).toEqual({ title: 'Page title' });
		expect(connected.withStructuredOutput).toHaveBeenCalledWith(expect.any(Object), {
			name: 'extractResult',
			includeRaw: true,
		});
	});

	it('returns a node error when structured output is unsupported', async () => {
		const connected = chatModel({ title: 'Page title' });
		delete connected.model.withStructuredOutput;
		const result = await Stagehand.prototype.execute.call(executionContext('act', connected.model));

		expect(result[0][0].error.message).toContain('does not support structured output');
	});

	it('passes screenshot content and tool calls through the Stagehand model callback', async () => {
		const connected = chatModel({});
		await Stagehand.prototype.execute.call(executionContext('act', connected.model));
		connected.invoke.mockResolvedValue(
			new AIMessage({
				content: '',
				tool_calls: [{ id: 'call-1', name: 'click', args: { element: 2 } }],
			}),
		);
		const result = await instances[0].options.model.generate({
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Click the button' },
						{ type: 'image', data: 'c2NyZWVuc2hvdA==', mimeType: 'image/png' },
					],
				},
			],
			tools: [{ name: 'click', description: 'Click an element', inputSchema: { type: 'object' } }],
			toolChoice: { mode: 'required' },
			responseFormat: { type: 'text' },
		});

		expect(connected.bindTools).toHaveBeenCalledWith(
			[{ name: 'click', description: 'Click an element', parameters: { type: 'object' } }],
			{ tool_choice: 'required' },
		);
		expect(connected.invoke.mock.calls.at(-1)[0][0].content).toEqual([
			{ type: 'text', text: 'Click the button' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,c2NyZWVuc2hvdA==' } },
		]);
		expect(result).toMatchObject({
			role: 'assistant',
			outputFormat: 'text',
			content: [{ type: 'tool_use', id: 'call-1', name: 'click', input: { element: 2 } }],
		});
	});
});
