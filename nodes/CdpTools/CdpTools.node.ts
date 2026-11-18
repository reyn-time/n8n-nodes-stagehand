import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

export class CdpTools implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CDP Tools',
		name: 'cdpTools',
		icon: 'file:chrome.svg',
		group: ['transform'],
		version: 1,
		description: 'Get information from a web page using Chrome DevTools Protocol',
		defaults: {
			name: 'CDP Tools',
		},
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		properties: [
			{
				displayName: 'CDP URL',
				name: 'url',
				type: 'string',
				default: '',
				placeholder: 'ws://localhost:9222/devtools/browser/...',
				description: 'Chrome DevTools Protocol URL to connect to the browser',
				required: true,
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const cdpUrl = this.getNodeParameter('url', i, '') as string;

			const { tree: snapshot, xpathMap } = await getAccessibilitySnapshot(cdpUrl);
			let tree = snapshot;
			const matches = tree.matchAll(/\[((?:\d+-)?\d+)\] /g);

			let j = 0;
			let offset = 0;
			const xpaths = [];
			for (const match of matches) {
				const before = tree.slice(0, match.index + offset);
				const after = tree.slice(match.index + match[0].length + offset);
				const replace = `[${j}] `;
				offset += replace.length - match[0].length;
				tree = `${before}${replace}${after}`;
				xpaths.push(xpathMap[match[1]]);
				j++;
			}

			results.push({
				json: {
					accessibilityTree: tree,
					xpaths,
				},
			});

			continue;
		}

		return [results];
	}
}

/**
 * Get the accessibility tree from the page.
 */
async function getAccessibilitySnapshot(
	cdpUrl: string,
): Promise<{ tree: string; xpathMap: Record<string, string> }> {
	const { localBrowser } = await import('@browserbasehq/stagehand');
	const browser = await localBrowser.connect({ cdpUrl });
	try {
		const page = await browser.context.activePage();
		if (!page) throw new UserError('The connected browser has no active page');
		const snapshot = await page.snapshot();
		return { tree: snapshot.formattedTree, xpathMap: snapshot.xpathMap };
	} finally {
		await browser.disconnect();
	}
}
