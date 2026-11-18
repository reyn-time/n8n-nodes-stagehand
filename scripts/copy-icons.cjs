const fs = require('node:fs/promises');
const path = require('node:path');

async function copyIcons(source, destination) {
	for (const entry of await fs.readdir(source, { withFileTypes: true })) {
		const sourcePath = path.join(source, entry.name);
		const destinationPath = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			await copyIcons(sourcePath, destinationPath);
		} else if (/\.(?:png|svg)$/i.test(entry.name)) {
			await fs.mkdir(destination, { recursive: true });
			await fs.copyFile(sourcePath, destinationPath);
		}
	}
}

copyIcons('nodes', path.join('dist', 'nodes')).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
