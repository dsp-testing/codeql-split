import test from 'ava';

import * as analysisPaths from './analysis-paths';
import {setupTests} from './testing-utils';
import * as util from './util';

setupTests(test);

test("emptyPaths", async t => {
  return await util.withTmpDir(async tmpDir => {
    const config = {
      languages: [],
      queries: {},
      pathsIgnore: [],
      paths: [],
      originalUserInput: {},
      tempDir: tmpDir,
      toolCacheDir: tmpDir,
      codeQLCmd: '',
    };
    analysisPaths.includeAndExcludeAnalysisPaths(config);
    t.is(process.env['LGTM_INDEX_INCLUDE'], undefined);
    t.is(process.env['LGTM_INDEX_EXCLUDE'], undefined);
    t.is(process.env['LGTM_INDEX_FILTERS'], undefined);
  });
});

test("nonEmptyPaths", async t => {
  return await util.withTmpDir(async tmpDir => {
    const config = {
      languages: [],
      queries: {},
      paths: ['path1', 'path2', '**/path3'],
      pathsIgnore: ['path4', 'path5', 'path6/**'],
      originalUserInput: {},
      tempDir: tmpDir,
      toolCacheDir: tmpDir,
      codeQLCmd: '',
    };
    analysisPaths.includeAndExcludeAnalysisPaths(config);
    t.is(process.env['LGTM_INDEX_INCLUDE'], 'path1\npath2');
    t.is(process.env['LGTM_INDEX_EXCLUDE'], 'path4\npath5');
    t.is(process.env['LGTM_INDEX_FILTERS'], 'include:path1\ninclude:path2\ninclude:**/path3\nexclude:path4\nexclude:path5\nexclude:path6/**');
  });
});
