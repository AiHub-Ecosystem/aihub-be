import process from 'node:process';
import {systemArchitectureSync as arch} from 'system-architecture';

const matchesFilter = (shouldCheck, expected, actual) => {
	return !shouldCheck || !expected || expected === actual;
};

const osFilterObj = input => {
	return input.filter(item => {
		return [process.platform, arch()].every((sysValue, index) => {
			return matchesFilter(index === 0, item.os, sysValue)
				&& matchesFilter(index === 1, item.arch, sysValue);
		});
	});
};

export default osFilterObj;
