# decompress-targz [![npm version](https://img.shields.io/npm/v/@xhmikosr/decompress-targz?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/decompress-targz) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/decompress-targz/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/decompress-targz/actions/workflows/ci.yml?query=branch%3Amaster)

> tar.gz decompress plugin


## Install

```sh
npm install @xhmikosr/decompress-targz
```


## Usage

```js
import decompress from '@xhmikosr/decompress';
import decompressTargz from '@xhmikosr/decompress-targz';

decompress('unicorn.tar.gz', 'dist', {
	plugins: [
		decompressTargz()
	]
}).then(() => {
	console.log('Files decompressed');
});
```


## API

### decompressTargz()(input)

Returns both a Promise for a Buffer and a [Duplex stream](https://nodejs.org/api/stream.html#stream_class_stream_duplex).

#### input

Type: `Buffer` `Stream`

Buffer or stream to decompress.


## License

MIT © [Kevin Mårtensson](https://github.com/kevva)
