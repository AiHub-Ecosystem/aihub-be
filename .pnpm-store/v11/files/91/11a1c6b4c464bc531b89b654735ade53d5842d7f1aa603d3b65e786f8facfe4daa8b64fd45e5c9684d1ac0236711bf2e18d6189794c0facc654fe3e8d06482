# @xhmikosr/os-filter-obj [![npm version](https://img.shields.io/npm/v/@xhmikosr/os-filter-obj?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/os-filter-obj) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/os-filter-obj/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/os-filter-obj/actions/workflows/ci.yml?query=branch%3Amaster)

> Filter an array of objects to a specific OS

## Install

```sh
npm install @xhmikosr/os-filter-obj
```

## Usage

```js
import osFilterObj from '@xhmikosr/os-filter-obj';

const objects = [{
	os: 'linux',
	arch: 'x64',
	foo: 'unicorn',
	bar: 'cow'
}, {
	os: 'darwin',
	arch: 'x64',
	foo: 'unicorn',
	bar: 'cow'
},{
	os: 'win32',
	arch: 'x64',
	foo: 'unicorn',
	bar: 'cow'
}];

osFilterObj(objects);
/*
	[{
		os: 'linux',
		arch: 'x64',
		foo: 'unicorn',
		bar: 'cow'
	}];
*/
```

## API

### osFilterObj(objects)

Returns an `Array` with the filtered objects.

#### objects

* Type: `Array`
* The `Array` to filter.

## License

MIT © [Kevin Mårtensson](https://github.com/kevva)
