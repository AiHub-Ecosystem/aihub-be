import {Buffer} from 'node:buffer';
import decompressTar from '@xhmikosr/decompress-tar';
import {fileTypeFromBuffer} from 'file-type';
import {isStream} from 'is-stream';
import seekBzip from 'seek-bzip';
import unbzip2Stream from 'unbzip2-stream';

const decompressTarBz2 = () => async input => {
	if (!Buffer.isBuffer(input) && !isStream(input)) {
		throw new TypeError(`Expected a Buffer or Stream, got ${typeof input}`);
	}

	if (Buffer.isBuffer(input)) {
		const type = await fileTypeFromBuffer(input);

		if (!type || type.mime !== 'application/x-bzip2') {
			return [];
		}

		return decompressTar()(seekBzip.decode(input));
	}

	return decompressTar()(input.pipe(unbzip2Stream()));
};

export default decompressTarBz2;
