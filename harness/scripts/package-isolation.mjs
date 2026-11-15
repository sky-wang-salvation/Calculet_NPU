import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CALCULET_PACKAGE_TEST_ROOT;
assert(root && path.isAbsolute(root), 'The package-test resolution boundary must be absolute.');
const boundary = path.resolve(root);
function contains(file) {
  const relative = path.relative(boundary, file);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
assert(contains(fileURLToPath(import.meta.url)), 'The resolution guard must be copied inside the clean sandbox.');

function checkURL(url, label) {
  if (url.startsWith('file:') && !contains(fileURLToPath(url))) {
    const error = new Error(`Package test refused a module outside its fresh installation: ${label}`);
    error.code = 'PACKAGE_TEST_RESOLUTION_ESCAPE';
    throw error;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    checkURL(result.url, specifier);
    return result;
  },
  load(url, context, nextLoad) {
    checkURL(url, 'module load');
    return nextLoad(url, context);
  },
});
