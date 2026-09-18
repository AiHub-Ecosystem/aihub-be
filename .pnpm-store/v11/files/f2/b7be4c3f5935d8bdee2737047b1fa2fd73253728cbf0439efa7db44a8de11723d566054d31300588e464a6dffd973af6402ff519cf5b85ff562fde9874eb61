import {execa, execaSync} from 'execa';
import {isexe, sync as isexeSync} from 'isexe';

const binCheck = async (bin, args) => {
	if (!Array.isArray(args)) {
		args = ['--help'];
	}

	const works = await isexe(bin);
	if (!works) {
		throw new Error(`Couldn't execute the "${bin}" binary. Make sure it has the right permissions.`);
	}

	const result = await execa(bin, args, {reject: false});

	return result.exitCode === 0;
};

binCheck.sync = (bin, args) => {
	if (!Array.isArray(args)) {
		args = ['--help'];
	}

	if (!isexeSync(bin)) {
		throw new Error(`Couldn't execute the "${bin}" binary. Make sure it has the right permissions.`);
	}

	return execaSync(bin, args, {reject: false}).exitCode === 0;
};

export default binCheck;
