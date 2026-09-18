import {Buffer} from 'node:buffer';
import {fileTypeFromBuffer} from 'file-type';

const extensions = new Set([
	'7z',
	'bz2',
	'gz',
	'tar.gz',
	'pkg',
	'rar',
	'tar',
	'zip',
	'xz',
	'zst',
]);

// XAR is the container format for macOS .pkg installers; file-type doesn't detect it
const XAR_MAGIC = 'xar!';

const xarDetector = {
	id: '@xhmikosr/archive-type:xar',
	async detect(tokenizer) {
		const head = Buffer.alloc(XAR_MAGIC.length);
		await tokenizer.peekBuffer(head, {
			length: XAR_MAGIC.length,
			mayBeLess: true, // don't throw on inputs shorter than the magic bytes
		});

		if (head.toString('binary') === XAR_MAGIC) {
			return {
				ext: 'pkg',
				mime: 'application/x-xar',
			};
		}
	},
};

const archiveType = async input => {
	const type = await fileTypeFromBuffer(input, {
		customDetectors: [xarDetector],
	});
	return extensions.has(type?.ext) ? type : null;
};

export default archiveType;
