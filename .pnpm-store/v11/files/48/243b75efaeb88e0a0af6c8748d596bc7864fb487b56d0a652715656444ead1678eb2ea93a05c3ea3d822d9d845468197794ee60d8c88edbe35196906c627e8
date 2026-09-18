/* eslint-disable no-bitwise */

import {Buffer} from 'node:buffer';
import {fileTypeFromBuffer} from 'file-type';
import {getStreamAsBuffer} from 'get-stream';
import yauzl from 'yauzl';

const getType = (entry, mode) => {
	const IFMT = 61_440;
	const IFDIR = 16_384;
	const IFLNK = 40_960;
	const madeBy = entry.versionMadeBy >> 8;

	if ((mode & IFMT) === IFLNK) {
		return 'symlink';
	}

	if ((mode & IFMT) === IFDIR || (madeBy === 0 && entry.externalFileAttributes === 16)) {
		return 'directory';
	}

	return 'file';
};

const extractEntry = async (entry, zip) => {
	const file = {
		mode: (entry.externalFileAttributes >> 16) & 0xFF_FF,
		mtime: entry.getLastModDate(),
		path: entry.fileName,
	};

	file.type = getType(entry, file.mode);

	if (file.mode === 0 && file.type === 'directory') {
		file.mode = 493;
	}

	if (file.mode === 0) {
		file.mode = 420;
	}

	const stream = await zip.openReadStreamPromise(entry);
	const data = await getStreamAsBuffer(stream);
	file.data = data;

	if (file.type === 'symlink') {
		file.linkname = data.toString();
	}

	return file;
};

const decompressUnzip = () => async input => {
	if (!Buffer.isBuffer(input)) {
		throw new TypeError(`Expected a Buffer, got ${typeof input}`);
	}

	const type = await fileTypeFromBuffer(input);

	if (!type || type.mime !== 'application/zip') {
		return [];
	}

	const zip = await yauzl.fromBufferPromise(input);
	const files = [];

	for await (const entry of zip.eachEntry()) {
		files.push(await extractEntry(entry, zip));
	}

	return files;
};

export default decompressUnzip;
