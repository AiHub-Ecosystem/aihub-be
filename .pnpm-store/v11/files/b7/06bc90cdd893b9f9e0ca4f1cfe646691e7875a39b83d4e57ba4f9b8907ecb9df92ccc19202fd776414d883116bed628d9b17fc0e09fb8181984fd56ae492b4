# @xhmikosr/bin-check [![npm version](https://img.shields.io/npm/v/@xhmikosr/bin-check?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/bin-check) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/bin-check/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/bin-check/actions/workflows/ci.yml?query=branch%3Amaster)

> Check if a binary is working by checking its exit code


## Install

```sh
npm install @xhmikosr/bin-check
```


## Usage

```js
import binCheck from '@xhmikosr/bin-check';

binCheck('/bin/sh', ['--version']).then(works => {
	console.log(works);
	//=> true
});
```


## API

### binCheck(binary, [arguments])

Returns a `Promise` for a `boolean`.

### binCheck.sync(binary, [arguments])

Returns a `boolean`.

#### binary

Type: `string`

Path to the binary.

#### arguments

* Type: `Array`
* Default: `['--help']`

Arguments to run the binary with.


## License

MIT © [Kevin Mårtensson](https://github.com/kevva)
