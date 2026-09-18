# @xhmikosr/archive-type [![npm version](https://img.shields.io/npm/v/@xhmikosr/archive-type?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/archive-type) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/archive-type/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/archive-type/actions/workflows/ci.yml?query=branch%3Amaster)

> Detect the archive type of a Buffer/Uint8Array


## Install

```sh
npm install @xhmikosr/archive-type
```


## Usage

```js
import archiveType from '@xhmikosr/archive-type';
import {readChunk} from 'read-chunk';

const buffer = await readChunk('unicorn.zip', 0, 262);

await archiveType(buffer);
//=> {ext: 'zip', mime: 'application/zip'}
```


## API

### archiveType(input)

Returns an `Object` with:

- `ext` - One of the [supported file types](#supported-file-types)
- `mime` - The [MIME type](https://en.wikipedia.org/wiki/Media_type)

Or `null` when no match.

#### input

Type: `Buffer` `Uint8Array`

It only needs the first 262 bytes.


## Supported file types

- `7z`
- `bz2`
- `gz`
- `pkg`
- `rar`
- `tar`
- `tar.gz`
- `xz`
- `zip`
- `zst`


## Related

- [archive-type-cli](https://github.com/kevva/archive-type-cli) - CLI for this module


## License

MIT © [Kevin Mårtensson](https://github.com/kevva)
