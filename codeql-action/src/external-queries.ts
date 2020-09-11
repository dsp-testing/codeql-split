import * as toolrunnner from '@actions/exec/lib/toolrunner';
import * as fs from 'fs';
import * as path from 'path';

import { Logger } from './logging';

/**
 * Check out repository at the given ref, and return the directory of the checkout.
 */
export async function checkoutExternalRepository(
  repository: string,
  ref: string,
  githubUrl: string,
  tempDir: string,
  logger: Logger): Promise<string> {

  logger.info('Checking out ' + repository);

  const checkoutLocation = path.join(tempDir, repository, ref);

  if (!checkoutLocation.startsWith(tempDir)) {
    // this still permits locations that mess with sibling repositories in `tempDir`, but that is acceptable
    throw new Error(`'${repository}@${ref}' is not a valid repository and reference.`);
  }

  if (!fs.existsSync(checkoutLocation)) {
    const repoURL = githubUrl + '/' + repository;
    await new toolrunnner.ToolRunner('git', ['clone', repoURL, checkoutLocation]).exec();
    await new toolrunnner.ToolRunner('git', [
      '--work-tree=' + checkoutLocation,
      '--git-dir=' + checkoutLocation + '/.git',
      'checkout', ref,
    ]).exec();
  }

  return checkoutLocation;
}
